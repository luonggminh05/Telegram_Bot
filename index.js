require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const express = require('express');
const fs = require('fs');
const csv = require('csv-parser');

const app = express();
app.use(express.json());

const PayOS = require('@payos/node');
const payos = new PayOS(
    process.env.PAYOS_CLIENT_ID,
    process.env.PAYOS_API_KEY,
    process.env.PAYOS_CHECKSUM_KEY
);

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: false });
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash-lite" });

const ADMIN_CHAT_ID = "6937078086";

let menu = [];
let toppings = [];
const userState = {};
const pendingOrders = {};

// LOAD DATA
function loadData() {
    return new Promise((resolve) => {
        fs.createReadStream('Menu.csv')
            .pipe(csv())
            .on('data', (row) => {
                if (row.available !== 'true') return;
                if (row.category === 'Topping') {
                    toppings.push({ id: row.item_id, name: row.name, price: Number(row.price_m) });
                } else {
                    menu.push({ id: row.item_id, name: row.name, price_m: Number(row.price_m), price_l: Number(row.price_l) });
                }
            })
            .on('end', resolve);
    });
}

const formatMoney = (amount) => new Intl.NumberFormat('vi-VN').format(amount) + 'đ';

// HELPER
function calcTotal(cart) {
    return cart.reduce((total, c) => {
        const price = c.size === 'L' ? c.price_l : c.price_m;
        const tPrice = (c.topping_ids || []).reduce((s, id) => {
            const t = toppings.find(t => t.id === id);
            return s + (t ? t.price : 0);
        }, 0);
        return total + (price + tPrice) * c.quantity;
    }, 0);
}

function buildFinalOrderText(state) {
    const optionLabel = { instore: 'Tại quán 🪑', takeaway: 'Mang đi 🥡', ship: 'Giao hàng 🚚' };
    const statusLabel = { cod: 'Thanh toán khi nhận món 🤝', paid: 'Đã thanh toán ✅', cash: 'Tiền mặt 💵' };

    let text = 'HÓA ĐƠN THANH TOÁN\n';
    text += 'Hình thức: ' + optionLabel[state.dining_option] + '\n';
    text += 'SDT: ' + state.phone + '\n';
    if (state.dining_option === 'ship') text += 'Địa chỉ: ' + state.address + '\n';
    text += '--------------------------\n';
    state.cart.forEach((c, i) => {
        text += (i + 1) + '. ' + c.name + ' (' + c.size + ') x' + c.quantity + '\n';
        if (c.topping_ids && c.topping_ids.length) {
            const names = c.topping_ids.map(id => {
                const t = toppings.find(t => t.id === id);
                return t ? t.name : '';
            });
            text += '   + Topping: ' + names.join(', ') + '\n';
        }
    });
    text += '--------------------------\n';
    text += 'Tổng tiền: ' + formatMoney(calcTotal(state.cart)) + '\n';
    text += 'Trạng thái: ' + statusLabel[state.payment_status] + '\n';
    text += 'Cảm ơn quý khách!';
    return text;
}

function notifyAdmin(orderText, isPaid = true) {
    const prefix = isPaid ? "✅ ĐÃ THANH TOÁN - " : "🔄 CHỜ THANH TOÁN - ";
    bot.sendMessage(ADMIN_CHAT_ID, prefix + "\n" + orderText);
}

function renderMenuKeyboard(state) {
    const keyboard = [];
    for (let i = 0; i < menu.length; i += 2) {
        const sel1 = state.selected_menu_ids && state.selected_menu_ids.includes(menu[i].id);
        const row = [{ text: (sel1 ? '✅ ' : '') + menu[i].name, callback_data: 'sel_menu_' + menu[i].id }];
        if (menu[i + 1]) {
            const sel2 = state.selected_menu_ids && state.selected_menu_ids.includes(menu[i + 1].id);
            row.push({ text: (sel2 ? '✅ ' : '') + menu[i + 1].name, callback_data: 'sel_menu_' + menu[i + 1].id });
        }
        keyboard.push(row);
    }
    keyboard.push([{ text: '🛒 Chọn món xong rồi!', callback_data: 'done_menu' }]);
    return keyboard;
}

function renderToppingKeyboard(state) {
    const keyboard = [];
    for (let i = 0; i < toppings.length; i += 2) {
        const sel1 = state.temp_item.topping_selected && state.temp_item.topping_selected[toppings[i].id];
        const row = [{ text: (sel1 ? '✅ ' : '') + toppings[i].name, callback_data: 'sel_top_' + toppings[i].id }];
        if (toppings[i + 1]) {
            const sel2 = state.temp_item.topping_selected && state.temp_item.topping_selected[toppings[i + 1].id];
            row.push({ text: (sel2 ? '✅ ' : '') + toppings[i + 1].name, callback_data: 'sel_top_' + toppings[i + 1].id });
        }
        keyboard.push(row);
    }
    keyboard.push([{ text: '➡️ Xong món này', callback_data: 'done_single_item' }]);
    return keyboard;
}

async function processNextItemDetail(chatId) {
    const state = userState[chatId];
    const item = state.pending_items.shift();
    state.temp_item = Object.assign({}, item, { quantity: 1, topping_selected: {} });
    bot.sendMessage(chatId, 'Món ' + item.name + ' bạn lấy size nào?', {
        reply_markup: {
            inline_keyboard: [[
                { text: 'Size M (' + formatMoney(item.price_m) + ')', callback_data: 'size_M' },
                { text: 'Size L (' + formatMoney(item.price_l) + ')', callback_data: 'size_L' }
            ]]
        }
    });
}

// AI
const ABBREVIATIONS = {
    'ts': 'tra sua',
    'tc': 'tran chau',
    'tcd': 'tran chau den',
    'tct': 'tran chau trang',
    'mt': 'matcha',
    'cf': 'ca phe',
    'cp': 'ca phe',
    'sl': 'sua chua',
};

function normalize(str) {
    if (!str) return '';
    let s = str.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
    s = s.split(/\s+/).map(word => ABBREVIATIONS[word] || word).join(' ');
    s = s.replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
    return s;
}

function findBestMatch(name, list) {
    if (!name || !list.length) return null;
    const n = normalize(name);
    const nWords = n.split(' ').filter(w => w.length > 1);
    let best = null;
    let bestScore = 0;

    for (const item of list) {
        const itemName = normalize(item.name);
        const itemWords = itemName.split(' ').filter(w => w.length > 1);

        if (itemName === n) return item;

        if (itemName.includes(n) || n.includes(itemName)) {
            const score = Math.min(n.length, itemName.length) / Math.max(n.length, itemName.length);
            if (score > bestScore) { bestScore = score; best = item; }
            continue;
        }

        const commonWords = nWords.filter(w => itemWords.includes(w));
        const wordScore = commonWords.length / Math.max(nWords.length, itemWords.length, 1);

        let charMatch = 0;
        for (let i = 0; i < Math.min(n.length, itemName.length); i++) {
            if (n[i] === itemName[i]) charMatch++;
        }
        const charScore = charMatch / Math.max(n.length, itemName.length, 1);

        const total = wordScore * 0.7 + charScore * 0.3;
        if (total > bestScore) { bestScore = total; best = item; }
    }

    return bestScore > 0.3 ? best : null;
}

function safeParseJSON(raw) {
    let cleaned = raw.replace(/```json|```/g, '').trim();
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
        const parsed = JSON.parse(match[0]);
        return {
            intent: ['NEW_ORDER','MODIFY_ORDER','CANCEL_ORDER','CONFIRM','UNKNOWN'].includes(parsed.intent)
                ? parsed.intent : 'UNKNOWN',
            items: Array.isArray(parsed.items) ? parsed.items : [],
            dining_hint: parsed.dining_hint || null,
            phone: parsed.phone || null,
            address: parsed.address || null,
            modifications: {
                replace_index: parsed.modifications?.replace_index ?? null,
                add_items: Array.isArray(parsed.modifications?.add_items) ? parsed.modifications.add_items : [],
                remove_index: parsed.modifications?.remove_index ?? null,
                update_quantity: parsed.modifications?.update_quantity ?? null,
                update_size: parsed.modifications?.update_size ?? null,
                target_index: parsed.modifications?.target_index ?? null,
                add_topping: parsed.modifications?.add_topping ?? null,
                remove_topping: parsed.modifications?.remove_topping ?? null,
            }
        };
    } catch {
        return null;
    }
}

async function understandOrder(text, currentCart) {
    try {
        const menuList = menu.map((m, i) => `[${i}] ${m.name} (M: ${m.price_m}đ, L: ${m.price_l}đ)`).join('\n');
        const toppingList = toppings.map(t => t.name).join(', ');
        const cartList = currentCart.map((c, i) => `[${i}] ${c.name} (${c.size}) x${c.quantity}`).join('\n') || 'Trống';

        const prompt = `Bạn là AI order trà sữa cực thông minh. Chỉ trả về JSON, không giải thích.

QUY TẮC QUAN TRỌNG:
- "items" CHỈ chứa các MÓN NƯỚC (trà, cà phê, đá xay...) — KHÔNG được đưa topping vào đây
- Topping phải đưa vào mảng "toppings" bên trong từng item
- Ví dụ: "trà xoài thêm nước cốt dừa" → items: [{name:"Trà Xoài", toppings:["Nước Cốt Dừa"]}]

QUY TẮC HIỂU INTENT:
- Khách nhắn tên món / gọi món → NEW_ORDER
- Khách nói "thêm", "thêm vào" → MODIFY_ORDER (add_items)
- Khách nói "đổi size", "size L", "size M", "lấy size L", "size L đi", "size L cơ" → MODIFY_ORDER + update_size
- Khách nói "đổi", "thay", "sửa", "tăng", "giảm" → MODIFY_ORDER
- Khách nói "bỏ", "xoá", "không lấy" → MODIFY_ORDER (remove_index)
- Khách nói "huỷ", "thôi", "không đặt nữa" → CANCEL_ORDER
- Khách nói "ok", "đặt", "xác nhận", "xong", "vậy đi" → CONFIRM
- Khách đặt kèm địa chỉ / "ship cho mình" / "giao tới" → NEW_ORDER + dining_hint: "ship"
- Khách nói "ghé qua", "tự đến lấy", "mang đi" → dining_hint: "takeaway"
- Khách ăn tại quán → dining_hint: "instore"
- Không hiểu → UNKNOWN

QUY TẮC VIẾT TẮT (hiểu tự nhiên):
- "ts" = trà sữa, "tc" = trân châu, "tcd"/"tc đen" = trân châu đen
- "size l"/"ly l"/"l" = size L, KHÔNG nói size = để null (không mặc định M)
- Số lượng: "2 ly", "3 cái", "x2" đều là quantity

KHI MODIFY size: update_size phải là "L" hoặc "M". Ví dụ "size L đi" → MODIFY_ORDER + update_size: "L", target_index: 0.
KHI MODIFY quantity: dùng target_index để chỉ đúng item (dựa số thứ tự [i] trong giỏ). Ví dụ "tăng ly thứ 2 lên 3" → target_index: 1, update_quantity: 3.

TRÍCH XUẤT THÔNG TIN KHÁCH:
- Nếu khách nhắn số điện thoại (10-11 chữ số) → đặt vào "phone"
- Nếu khách nhắn địa chỉ giao hàng → đặt vào "address"
- Ví dụ: "ship tới, sdt 0943648249, địa chỉ Đông Hòa, Dĩ An" → dining_hint: "ship", phone: "0943648249", address: "Đông Hòa, Dĩ An"

QUY TẮC SIZE QUAN TRỌNG:
- Nếu khách KHÔNG đề cập size → để "size": null trong items (KHÔNG điền M)
- Nếu khách nói "size M" hoặc "ly M" → "size": "M"
- Nếu khách nói "size L" hoặc "ly L" → "size": "L"

DANH SÁCH MÓN NƯỚC (chỉ những thứ này mới được vào "items"):
${menuList}

TOPPING CÓ SẴN (chỉ được vào mảng "toppings" trong item, KHÔNG được vào "items"): ${toppingList}

GIỎ HIỆN TẠI:
${cartList}

TIN NHẮN KHÁCH: "${text}"

Trả về JSON (KHÔNG có text thừa, KHÔNG có markdown):
{
  "intent": "NEW_ORDER|MODIFY_ORDER|CANCEL_ORDER|CONFIRM|UNKNOWN",
  "dining_hint": null,
  "phone": null,
  "address": null,
  "items": [{"name":"...","size":null,"quantity":1,"toppings":[]}],
  "modifications": {
    "replace_index": null,
    "add_items": [],
    "remove_index": null,
    "target_index": null,
    "update_quantity": null,
    "update_size": null,
    "add_topping": null,
    "remove_topping": null
  }
}`;

        const res = await model.generateContent(prompt);
        const raw = res.response.text();
        const parsed = safeParseJSON(raw);
        if (!parsed) console.warn("AI parse thất bại, raw:", raw.slice(0, 200));
        return parsed;
    } catch (err) {
        console.error("AI lỗi:", err.message);
        return null;
    }
}

function buildCartFromAI(aiData) {
    console.log("[DEBUG] AI items:", JSON.stringify(aiData.items));
    const cart = [];

    for (const item of aiData.items || []) {
        const menuItem = findBestMatch(item.name, menu);
        if (!menuItem) continue;

        const topping_ids = [];
        if (item.toppings) {
            for (const tName of item.toppings) {
                const t = findBestMatch(tName, toppings);
                if (t) topping_ids.push(t.id);
            }
        }

        cart.push({
            id: menuItem.id,
            name: menuItem.name,
            price_m: menuItem.price_m,
            price_l: menuItem.price_l,
            size: item.size === 'L' ? 'L' : item.size === 'M' ? 'M' : null, // null = chưa chọn size
            topping_ids,
            quantity: item.quantity || 1
        });
    }

    console.log("[DEBUG] Cart built:", JSON.stringify(cart.map(c => ({ name: c.name, size: c.size, qty: c.quantity, topping_ids: c.topping_ids }))));
    return cart;
}

function applyAIResult(state, aiData) {
    if (!aiData) return null;

    if (aiData.intent === "NEW_ORDER") {
        const built = buildCartFromAI(aiData);
        if (!built.length) return null;
        state.cart = built;
        if (aiData.dining_hint) state.dining_hint = aiData.dining_hint;
        // Lưu phone và address nếu khách cung cấp trong cùng 1 tin nhắn
        if (aiData.phone && /^\d{10,11}$/.test(aiData.phone.trim())) {
            state.phone = aiData.phone.trim();
        }
        if (aiData.address) {
            state.address = aiData.address.trim();
        }
        // Nếu có dining_hint → cũng lưu dining_option
        if (aiData.dining_hint) {
            state.dining_option = aiData.dining_hint;
        }
        return "new";
    }

    if (aiData.intent === "MODIFY_ORDER") {
        const mod = aiData.modifications || {};

        const targetIdx = (mod.target_index !== null && mod.target_index !== undefined && state.cart[mod.target_index])
            ? mod.target_index : 0;

        if (mod.replace_index !== null && mod.replace_index !== undefined && aiData.items?.length) {
            const newItem = buildCartFromAI({ items: [aiData.items[0]] })[0];
            if (newItem && state.cart[mod.replace_index]) {
                state.cart[mod.replace_index] = newItem;
            }
        }

        if (mod.add_items?.length) {
            state.cart.push(...buildCartFromAI({ items: mod.add_items }));
        }

        if (mod.remove_index !== null && mod.remove_index !== undefined) {
            state.cart.splice(mod.remove_index, 1);
        }

        if (mod.update_quantity && state.cart.length) {
            state.cart[targetIdx].quantity = mod.update_quantity;
        }

        if (mod.update_size && state.cart.length) {
            state.cart[targetIdx].size = mod.update_size.toUpperCase() === 'L' ? 'L' : 'M';
        }

        if (mod.add_topping && state.cart.length) {
            const t = findBestMatch(mod.add_topping, toppings);
            if (t && !state.cart[targetIdx].topping_ids.includes(t.id)) {
                state.cart[targetIdx].topping_ids.push(t.id);
            }
        }

        if (mod.remove_topping && state.cart.length) {
            const t = findBestMatch(mod.remove_topping, toppings);
            if (t) {
                state.cart[targetIdx].topping_ids = state.cart[targetIdx].topping_ids.filter(id => id !== t.id);
            }
        }

        return "modify";
    }

    if (aiData.intent === "CANCEL_ORDER") {
        state.cart = [];
        state.dining_hint = null;
        return "cancel";
    }

    if (aiData.intent === "CONFIRM") {
        return "confirm";
    }

    return null;
}

function sendCartSummary(chatId, cart) {
    if (!cart.length) {
        return bot.sendMessage(chatId, "Giỏ hàng đang trống 😢\nBạn nhắn tên món muốn gọi hoặc bấm 📋 Menu nha!");
    }

    let text = "🛒 *Đơn của bạn:*\n";
    cart.forEach((c, i) => {
        const toppingNames = (c.topping_ids || []).map(id => {
            const t = toppings.find(t => t.id === id);
            return t ? t.name : '';
        }).filter(Boolean);
        text += `${i + 1}. ${c.name} (${c.size}) x${c.quantity} — ${formatMoney((c.size === 'L' ? c.price_l : c.price_m) * c.quantity)}\n`;
        if (toppingNames.length) text += `   ➕ ${toppingNames.join(', ')}\n`;
    });
    text += `\n💰 *Tổng: ${formatMoney(calcTotal(cart))}*`;
    return bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
}

function buildToppingKeyboardAI(state) {
    const target = state.cart[state.ai_topping_target || 0] || {};
    const selected = target.topping_ids || [];
    const keyboard = [];
    for (let i = 0; i < toppings.length; i += 2) {
        const row = [{
            text: (selected.includes(toppings[i].id) ? '✅ ' : '') + toppings[i].name,
            callback_data: 'ait_' + toppings[i].id
        }];
        if (toppings[i + 1]) row.push({
            text: (selected.includes(toppings[i + 1].id) ? '✅ ' : '') + toppings[i + 1].name,
            callback_data: 'ait_' + toppings[i + 1].id
        });
        keyboard.push(row);
    }
    keyboard.push([
        { text: '➡️ Xong, tiếp tục', callback_data: 'ait_done' },
        { text: '🗑️ Huỷ đơn', callback_data: 'ai_cancel' }
    ]);
    return keyboard;
}

async function askSize(chatId) {
    const state = userState[chatId];
    // Tìm item đầu tiên chưa có size (hoặc size M mặc định mà cần xác nhận)
    const item = state.cart[state.ai_size_target || 0];
    if (!item) return askToppingConfirm(chatId);
    state.step = 'CHOOSE_SIZE_AI';
    return bot.sendMessage(chatId, `📏 Bạn muốn lấy *${item.name}* size nào?`, {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [[
                { text: `Size M (${formatMoney(item.price_m)})`, callback_data: 'ai_size_M' },
                { text: `Size L (${formatMoney(item.price_l)})`, callback_data: 'ai_size_L' }
            ]]
        }
    });
}

async function askToppingConfirm(chatId) {
    const state = userState[chatId];
    state.step = 'ASK_TOPPING_CONFIRM';
    return bot.sendMessage(chatId, '🧋 Bạn có muốn thêm topping không?', {
        reply_markup: {
            inline_keyboard: [[
                { text: '✅ Có, chọn topping', callback_data: 'topping_yes' },
                { text: '❌ Không cần', callback_data: 'topping_no' }
            ]]
        }
    });
}

async function askToppings(chatId) {
    const state = userState[chatId];
    state.step = 'CHOOSE_TOPPING_AI';
    state.ai_topping_target = 0;
    return bot.sendMessage(chatId, '🦹 Bạn chọn topping muốn thêm nha! (bấm vào để chọn)', {
        reply_markup: { inline_keyboard: buildToppingKeyboardAI(state) }
    });
}

async function askDining(chatId) {
    const state = userState[chatId];
    // Nếu đã biết dining_option rồi thì bỏ qua
    if (state.dining_option) {
        return proceedAfterTopping(chatId);
    }
    state.step = 'CHOOSE_DINING_AI';
    return bot.sendMessage(chatId, '🍹 Bạn đặt theo hình thức nào?', {
        reply_markup: {
            inline_keyboard: [[
                { text: '🪣 Ghé qua lấy', callback_data: 'ai_dining_takeaway' },
                { text: '🚚 Ship tới nhà', callback_data: 'ai_dining_ship' }
            ]]
        }
    });
}

// Kiểm tra state đã đủ thông tin chưa, nếu đủ thì hỏi thanh toán luôn
async function proceedAfterTopping(chatId) {
    const state = userState[chatId];

    // Chưa biết hình thức → hỏi dining
    if (!state.dining_option) {
        state.step = 'CHOOSE_DINING_AI';
        return bot.sendMessage(chatId, '🍹 Bạn đặt theo hình thức nào?', {
            reply_markup: {
                inline_keyboard: [[
                    { text: '🪣 Ghé qua lấy', callback_data: 'ai_dining_takeaway' },
                    { text: '🚚 Ship tới nhà', callback_data: 'ai_dining_ship' }
                ]]
            }
        });
    }

    // Đã biết ship nhưng chưa có phone → hỏi phone
    if (state.dining_option === 'ship' && !state.phone) {
        state.step = 'INPUT_PHONE';
        return bot.sendMessage(chatId, 'Cho mình xin số điện thoại để giao hàng nha! 📞');
    }

    // Đã biết ship + phone nhưng chưa có address → hỏi address
    if (state.dining_option === 'ship' && !state.address) {
        state.step = 'INPUT_ADDRESS';
        return bot.sendMessage(chatId, 'Bạn cho mình biết địa chỉ giao hàng nha! 📍');
    }

    // Đã biết takeaway/instore nhưng chưa có phone → hỏi phone
    if ((state.dining_option === 'takeaway' || state.dining_option === 'instore') && !state.phone) {
        state.step = 'INPUT_PHONE';
        return bot.sendMessage(chatId, 'Cho mình xin số điện thoại nha! 📞');
    }

    // Đã đủ hết → hỏi thanh toán
    return askPayment(chatId);
}

async function askPayment(chatId) {
    const state = userState[chatId];
    if (state.dining_option === 'ship') {
        state.step = 'CHOOSE_PAYMENT_SHIP';
        return bot.sendMessage(chatId, '💳 Bạn muốn thanh toán khi nhận hàng hay chuyển khoản trước?', {
            reply_markup: {
                inline_keyboard: [[
                    { text: '🤝 Khi nhận món (COD)', callback_data: 'pay_cod' },
                    { text: '💳 Chuyển khoản trước', callback_data: 'pay_transfer' }
                ]]
            }
        });
    } else {
        // Takeaway/instore: thanh toán tiền mặt tại quán
        state.payment_status = 'cash';
        const orderText = buildFinalOrderText(state);
        bot.sendMessage(chatId, orderText);
        bot.sendMessage(chatId, 'Mình nhận đơn rồi nha! Ghé qua lấy đồ nhé ❤️');
        notifyAdmin(orderText, false);
        delete userState[chatId];
    }
}

async function talkAI(prompt) {
    try {
        const result = await model.generateContent('Bạn là chủ quán trà sữa dễ thương. Xung hô mình - bạn. Nói ngắn gọn: ' + prompt);
        return result.response.text();
    } catch {
        return 'Xin chào bạn! Bạn muốn gọi món gì nè? 😊';
    }
}

// BOT START COMMAND — chào khi khách mở chat lần đầu
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    userState[chatId] = { cart: [], selected_menu_ids: [] }; // reset sạch state cũ

    const greeting = await talkAI('Khách vừa mở chat với quán lần đầu. Hãy chào đón thật thân thiện và hỏi khách muốn dùng gì.');
    bot.sendMessage(chatId, greeting, {
        reply_markup: { keyboard: [['📋 Menu']], resize_keyboard: true }
    });
});

// BOT MESSAGE HANDLER
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;
    if (!text || text.startsWith('/')) return;

    if (!userState[chatId]) userState[chatId] = { cart: [], selected_menu_ids: [] };
    const state = userState[chatId];

    // Các step đang chờ input text
    if (state.step === 'INPUT_PHONE') {
        if (!/^\d{10,11}$/.test(text.trim())) {
            return bot.sendMessage(chatId, 'Số điện thoại chưa đúng rồi, bạn nhập lại giúp mình nha! (10-11 số)');
        }
        state.phone = text.trim();
        if (state.dining_option === 'ship') {
            state.step = 'INPUT_ADDRESS';
            return bot.sendMessage(chatId, 'Bạn cho mình biết địa chỉ giao hàng nha! 📍');
        } else {
            // Ghé qua lấy: không hỏi thanh toán, hoàn tất ngay
            state.payment_status = 'cash';
            const orderText = buildFinalOrderText(state);
            bot.sendMessage(chatId, orderText);
            bot.sendMessage(chatId, 'Mình nhận đơn rồi nha! Ghé qua lấy đồ nhé ❤️');
            notifyAdmin(orderText, false);
            delete userState[chatId];
        }
    }

    if (state.step === 'INPUT_ADDRESS') {
        state.address = text.trim();
        state.step = 'CHOOSE_PAYMENT_SHIP';
        return bot.sendMessage(chatId, 'Bạn muốn thanh toán khi nhận món hay thanh toán trước nè?', {
            reply_markup: {
                inline_keyboard: [[
                    { text: '🤝 Khi nhận món (COD)', callback_data: 'pay_cod' },
                    { text: '💳 Chuyển khoản trước', callback_data: 'pay_transfer' }
                ]]
            }
        });
    }

    // Step: chọn topping sau khi AI tạo đơn
    if (state.step === 'CHOOSE_TOPPING_AI') {
        // Cho phép sửa đơn bằng text trong lúc chọn topping
        const aiData = await understandOrder(text, state.cart || []);
        if (aiData && (aiData.intent === 'MODIFY_ORDER' || aiData.intent === 'CANCEL_ORDER')) {
            const result = applyAIResult(state, aiData);
            if (result === 'cancel') {
                state.step = null;
                return bot.sendMessage(chatId, 'Đơn đã huỷ nha 😢 Bạn muốn gọi lại không?');
            }
            if (result === 'modify') {
                await sendCartSummary(chatId, state.cart);
                return askToppings(chatId);
            }
        }
        return; // bỏ qua các tin nhắn khác khi đang chọn topping
    }

    // Bấm Menu cứng
    if (text === '📋 Menu') {
        state.selected_menu_ids = [];
        return bot.sendMessage(chatId, 'Bạn chọn món nào nè:', {
            reply_markup: { inline_keyboard: renderMenuKeyboard(state) }
        });
    }

    // Step: đang chờ chọn size qua AI flow
    if (state.step === 'CHOOSE_SIZE_AI') {
        // Cho phép huỷ bằng text
        const aiData = await understandOrder(text, state.cart || []);
        if (aiData && aiData.intent === 'CANCEL_ORDER') {
            state.cart = [];
            state.step = null;
            return bot.sendMessage(chatId, 'Đơn đã huỷ nha 😢 Bạn muốn gọi lại không?');
        }
        return; // bỏ qua các tin nhắn khác khi đang chọn size
    }

    // Step: đang chờ xác nhận topping
    if (state.step === 'ASK_TOPPING_CONFIRM') {
        // Cho phép huỷ bằng text
        const aiData = await understandOrder(text, state.cart || []);
        if (aiData && aiData.intent === 'CANCEL_ORDER') {
            state.cart = [];
            state.step = null;
            return bot.sendMessage(chatId, 'Đơn đã huỷ nha 😢 Bạn muốn gọi lại không?');
        }
        return; // bỏ qua các tin nhắn khác khi đang chọn
    }

    // AI xử lý tất cả (đặt món, chào hỏi, huỷ...)
    if (!state.step) {
        const aiData = await understandOrder(text, state.cart || []);

        if (!aiData) {
            return bot.sendMessage(chatId, 'Mình đang bận xíu, bạn nhắn lại giúp mình nha! 🙏');
        }

        const result = applyAIResult(state, aiData);

        if (result === "new" || result === "modify") {
            const label = result === "new" ? "Mình hiểu bạn gọi món rồi nè 👇" : "Mình cập nhật đơn cho bạn nha 👇";
            await bot.sendMessage(chatId, label);
            await sendCartSummary(chatId, state.cart);

            // Kiểm tra xem các item trong đơn có size chưa (null = chưa nói)
            const needSizeCheck = state.cart.some(item => !item.size);
            if (needSizeCheck) {
                state.ai_size_target = 0;
                return askSize(chatId);
            }

            return askToppingConfirm(chatId);
        }

        if (result === "cancel") {
            return bot.sendMessage(chatId, "Đơn đã huỷ nha 😢 Bạn muốn gọi lại không?");
        }

        if (result === "confirm") {
            if (!state.cart.length) {
                return bot.sendMessage(chatId, "Giỏ hàng đang trống bạn ơi 😅 Gọi món trước nha!");
            }
            return bot.sendMessage(chatId, 'Bạn muốn dùng tại quán, mang đi hay ship nè? 😊', {
                reply_markup: {
                    inline_keyboard: [[
                        { text: '🪑 Tại quán', callback_data: 'opt_instore' },
                        { text: '🥡 Mang đi', callback_data: 'opt_takeaway' },
                        { text: '🚚 Đặt ship', callback_data: 'opt_ship' }
                    ]]
                }
            });
        }

        // UNKNOWN hoặc chào hỏi → để AI trả lời tự nhiên
        return bot.sendMessage(chatId, await talkAI(text), {
            reply_markup: { keyboard: [['📋 Menu']], resize_keyboard: true }
        });
    }
});

// CALLBACK QUERY HANDLER
bot.on('callback_query', async (q) => {
    const chatId = q.message.chat.id;
    const data = q.data;
    const state = userState[chatId];

    if (!state) return bot.answerCallbackQuery(q.id);

    // AI flow shortcuts
    if (data === 'ai_confirm') {
        // Legacy: redirect to topping step
        bot.answerCallbackQuery(q.id);
        if (!state.cart.length) return;
        return askToppingConfirm(chatId);
    }

    if (data === 'ai_cancel') {
        state.cart = [];
        state.step = null;
        bot.answerCallbackQuery(q.id, { text: 'Đã huỷ đơn!' });
        return bot.sendMessage(chatId, 'Đơn đã huỷ nha 😢 Bạn muốn gọi lại không?');
    }

    // Chọn size trong AI flow
    if (data === 'ai_size_M' || data === 'ai_size_L') {
        bot.answerCallbackQuery(q.id);
        const size = data === 'ai_size_L' ? 'L' : 'M';
        const target = state.ai_size_target || 0;
        if (state.cart[target]) {
            state.cart[target].size = size;
        }
        state.step = null;
        // Tiếp tục hỏi size các item còn lại (nếu có)
        state.ai_size_target = target + 1;
        if (state.ai_size_target < state.cart.length) {
            return askSize(chatId);
        }
        state.ai_size_target = 0;
        return askToppingConfirm(chatId);
    }

    // Xác nhận topping
    if (data === 'topping_yes') {
        bot.answerCallbackQuery(q.id);
        return askToppings(chatId);
    }

    if (data === 'topping_no') {
        bot.answerCallbackQuery(q.id);
        state.step = null;
        await sendCartSummary(chatId, state.cart);
        return bot.sendMessage(chatId, 'Bạn xác nhận đặt hàng chứ?', {
            reply_markup: {
                inline_keyboard: [[
                    { text: '✅ Đặt hàng luôn!', callback_data: 'ai_proceed_dining' },
                    { text: '🗑️ Huỷ đơn', callback_data: 'ai_cancel' }
                ]]
            }
        });
    }

    if (data === 'ai_proceed_dining') {
        bot.answerCallbackQuery(q.id);
        return proceedAfterTopping(chatId);
    }

    // Topping AI flow
    if (data.startsWith('ait_') && data !== 'ait_done') {
        const id = data.replace('ait_', '');
        const targetItem = state.cart[state.ai_topping_target || 0];
        if (targetItem) {
            const idx = targetItem.topping_ids.indexOf(id);
            if (idx > -1) targetItem.topping_ids.splice(idx, 1);
            else targetItem.topping_ids.push(id);
            bot.editMessageReplyMarkup({ inline_keyboard: buildToppingKeyboardAI(state) }, { chat_id: chatId, message_id: q.message.message_id });
        }
        return bot.answerCallbackQuery(q.id);
    }

    if (data === 'ait_done') {
        bot.answerCallbackQuery(q.id);
        await sendCartSummary(chatId, state.cart);
        return proceedAfterTopping(chatId);
    }

    // Dining AI flow
    if (data === 'ai_dining_takeaway') {
        bot.answerCallbackQuery(q.id);
        state.dining_option = 'takeaway';
        return proceedAfterTopping(chatId);
    }

    if (data === 'ai_dining_ship') {
        bot.answerCallbackQuery(q.id);
        state.dining_option = 'ship';
        return proceedAfterTopping(chatId);
    }

    // Menu chọn bằng nút
    if (data.startsWith('sel_menu_')) {
        const id = data.replace('sel_menu_', '');
        const idx = state.selected_menu_ids.indexOf(id);
        if (idx > -1) state.selected_menu_ids.splice(idx, 1);
        else state.selected_menu_ids.push(id);
        bot.editMessageReplyMarkup({ inline_keyboard: renderMenuKeyboard(state) }, { chat_id: chatId, message_id: q.message.message_id });
    }

    if (data === 'done_menu') {
        if (!state.selected_menu_ids.length) {
            bot.answerCallbackQuery(q.id);
            const reminder = await talkAI('Khách chưa chọn món nào mà bấm xong rồi. Nhắc nhở nhẹ nhàng để khách chọn món đi.');
            return bot.sendMessage(chatId, reminder);
        }
        state.pending_items = state.selected_menu_ids.map(id => menu.find(m => m.id === id));
        bot.deleteMessage(chatId, q.message.message_id);
        processNextItemDetail(chatId);
    }

    // Chọn size
    if (data.startsWith('size_')) {
        state.temp_item.size = data.replace('size_', '');
        state.temp_item.topping_selected = {};
        bot.sendMessage(chatId, 'Bạn muốn thêm topping cho món ' + state.temp_item.name + ' không?', {
            reply_markup: { inline_keyboard: renderToppingKeyboard(state) }
        });
    }

    // Chọn topping
    if (data.startsWith('sel_top_')) {
        const id = data.replace('sel_top_', '');
        state.temp_item.topping_selected[id] = !state.temp_item.topping_selected[id];
        bot.editMessageReplyMarkup({ inline_keyboard: renderToppingKeyboard(state) }, { chat_id: chatId, message_id: q.message.message_id });
    }

    if (data === 'done_single_item') {
        state.temp_item.topping_ids = Object.keys(state.temp_item.topping_selected).filter(k => state.temp_item.topping_selected[k]);
        state.cart.push(state.temp_item);
        state.temp_item = null;
        if (state.pending_items && state.pending_items.length > 0) {
            processNextItemDetail(chatId);
        } else {
            bot.sendMessage(chatId, 'Bạn muốn dùng tại quán, mang đi hay đặt ship nè? 😊', {
                reply_markup: {
                    inline_keyboard: [[
                        { text: '🪑 Tại quán', callback_data: 'opt_instore' },
                        { text: '🥡 Mang đi', callback_data: 'opt_takeaway' },
                        { text: '🚚 Đặt ship', callback_data: 'opt_ship' }
                    ]]
                }
            });
        }
    }

    // Hình thức dùng
    if (data.startsWith('opt_')) {
        state.dining_option = data.replace('opt_', '');
        state.step = 'INPUT_PHONE';
        bot.sendMessage(chatId, 'Bạn cho mình xin số điện thoại nha! 📞');
    }

    // Thanh toán
    if (data === 'pay_cash' || data === 'pay_cod') {
        state.payment_status = data === 'pay_cash' ? 'cash' : 'cod';
        const orderText = buildFinalOrderText(state);
        bot.sendMessage(chatId, orderText);
        bot.sendMessage(chatId, 'Mình nhận đơn rồi nha! Đợi mình một xíu ❤️');
        notifyAdmin(orderText, false);
        delete userState[chatId];
        return bot.answerCallbackQuery(q.id);
    }

    if (data === 'pay_transfer') {
        try {
            bot.sendMessage(chatId, '⏳ Đang tạo link thanh toán, chờ mình xíu nha...');
            const orderCode = Number(String(Date.now()).slice(-6));
            pendingOrders[orderCode] = {
                chatId: chatId,
                stateSnapshot: JSON.parse(JSON.stringify(state))
            };

            const body = {
                orderCode,
                amount: calcTotal(state.cart),
                description: 'DH' + orderCode,
                returnUrl: 'https://t.me/MomMT_bot',
                cancelUrl: 'https://t.me/MomMT_bot'
            };

            const link = await payos.createPaymentLink(body);
            bot.sendMessage(chatId, '💳 Bạn quét mã này để chuyển khoản nha:\n' + link.checkoutUrl + '\n\nSau khi chuyển xong, mình sẽ xác nhận đơn ngay!');
        } catch (err) {
            bot.sendMessage(chatId, '❌ Lỗi tạo link thanh toán: ' + err.message);
        }
    }

    bot.answerCallbackQuery(q.id);
});

// PAYOS WEBHOOK
app.post('/payos-webhook', async (req, res) => {
    res.sendStatus(200);

    try {
        console.log("[PayOS] Webhook nhận:", JSON.stringify(req.body));

        const webhookData = payos.verifyPaymentWebhookData(req.body);

        console.log("[PayOS] Verify OK:", webhookData);

        const { orderCode, code } = webhookData;
        const isPaid = code === '00';

        if (isPaid && pendingOrders[orderCode]) {
            const { chatId, stateSnapshot } = pendingOrders[orderCode];

            stateSnapshot.payment_status = 'paid';
            const orderText = buildFinalOrderText(stateSnapshot);

            bot.sendMessage(chatId, '✅ Thanh toán thành công!\n\n' + orderText);
                notifyAdmin(orderText, true);

            delete pendingOrders[orderCode];
            delete userState[chatId];

            console.log("[PayOS] DONE order:", orderCode);
        } else {
            console.log("[PayOS] Không tìm thấy order hoặc chưa success. orderCode:", orderCode, "| code:", code);
        }

    } catch (err) {
        console.error("[PayOS] Verify fail:", err.message);
    }
});

// WEBHOOK ENDPOINT
app.post(`/bot${process.env.BOT_TOKEN}`, (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200);
});

// START
loadData().then(async () => {
    const PORT = process.env.PORT || 3000;
    const BASE_URL = process.env.RAILWAY_PUBLIC_DOMAIN
        ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
        : process.env.BASE_URL;
 
    app.listen(PORT, async () => {
        console.log(`Server up on port ${PORT} | Menu: ${menu.length} món | Topping: ${toppings.length}`);
 
        if (BASE_URL) {
            const WEBHOOK_URL = `${BASE_URL}/bot${process.env.BOT_TOKEN}`;
            await bot.deleteWebHook();
            await bot.setWebHook(WEBHOOK_URL);
            console.log('Telegram Webhook set:', WEBHOOK_URL);
 
            try {
                const payosWebhookUrl = `${BASE_URL}/payos-webhook`;
                await payos.confirmWebhook(payosWebhookUrl);
                console.log('PayOS Webhook confirmed:', payosWebhookUrl);
            } catch (err) {
                console.warn('PayOS Webhook confirm lỗi:', err.message);
            }
        } else {
            console.warn('BASE_URL chưa set — webhook chưa được đăng ký!');
        }
    });
});