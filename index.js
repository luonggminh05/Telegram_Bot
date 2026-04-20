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

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

const ADMIN_CHAT_ID = "6937078086"; 

let menu = [];
let toppings = [];
const userState = {};
const pendingOrders = {}; 

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

async function talkAI(prompt) {
    try {
        const result = await model.generateContent('Bạn là chủ quán trà sữa dễ thương. Xung hô với mình - bạn. Nói ngắn gọn: ' + prompt);
        return result.response.text();
    } catch {
        return 'Xin chào, bạn chọn món giúp mình nha!';
    }
}

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

    let text = '==== HOA DON DAT HANG ====\n';
    text += 'Hình thức: ' + optionLabel[state.dining_option] + '\n';
    text += 'SDT: ' + state.phone + '\n';
    if (state.dining_option === 'ship') text += 'Địa chỉ: ' + state.address + '\n';
    text += '--------------------------\n';
    state.cart.forEach((c, i) => {
        text += (i + 1) + '. ' + c.name + ' (' + c.size + ')\n';
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
    text += '==========================';
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

bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;
    if (!text || text.startsWith('/')) return;

    if (!userState[chatId]) userState[chatId] = { cart: [], selected_menu_ids: [] };
    const state = userState[chatId];

    if (state.step === 'INPUT_PHONE') {
        if (!/^\d{10,11}$/.test(text.trim())) {
            return bot.sendMessage(chatId, 'Số điện thoại chưa đúng rồi, bạn nhập lại giúp mình nha! (10-11 số)');
        }
        state.phone = text.trim();
        if (state.dining_option === 'ship') {
            state.step = 'INPUT_ADDRESS';
            return bot.sendMessage(chatId, 'Bạn cho mình biết địa chỉ giao hàng nha! 📍');
        } else {
            state.step = 'CHOOSE_PAYMENT';
            return bot.sendMessage(chatId, 'Bạn muốn dùng phương thức nào để thanh toán nè?', {
                reply_markup: {
                    inline_keyboard: [[
                        { text: '💵 Tiền mặt', callback_data: 'pay_cash' },
                        { text: '💳 Chuyển khoản', callback_data: 'pay_transfer' }
                    ]]
                }
            });
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

    const lower = text.toLowerCase();
    if (lower.includes('xin chào') || lower.includes('hello') || lower.includes('hi ')) {
        bot.sendMessage(chatId, await talkAI(text), {
            reply_markup: { keyboard: [['📋 Menu']], resize_keyboard: true }
        });
        return;
    }

    if (text === '📋 Menu') {
        state.selected_menu_ids = [];
        bot.sendMessage(chatId, 'Bạn chọn món nào nè:', {
            reply_markup: { inline_keyboard: renderMenuKeyboard(state) }
        });
    }
});

bot.on('callback_query', async (q) => {
    const chatId = q.message.chat.id;
    const data = q.data;
    const state = userState[chatId];

    if (!state) return;

    if (data.startsWith('sel_menu_')) {
        const id = data.replace('sel_menu_', '');
        const idx = state.selected_menu_ids.indexOf(id);
        if (idx > -1) state.selected_menu_ids.splice(idx, 1);
        else state.selected_menu_ids.push(id);
        bot.editMessageReplyMarkup({ inline_keyboard: renderMenuKeyboard(state) }, { chat_id: chatId, message_id: q.message.message_id });
    }

    if (data === 'done_menu') {
        if (!state.selected_menu_ids.length) return bot.answerCallbackQuery(q.id, { text: 'Bạn chưa chọn món nào!', show_alert: true });
        state.pending_items = state.selected_menu_ids.map(id => menu.find(m => m.id === id));
        bot.deleteMessage(chatId, q.message.message_id);
        processNextItemDetail(chatId);
    }

    if (data.startsWith('size_')) {
        state.temp_item.size = data.replace('size_', '');
        state.temp_item.topping_selected = {};
        bot.sendMessage(chatId, 'Bạn muốn thêm topping cho món ' + state.temp_item.name + ' không?', {
            reply_markup: { inline_keyboard: renderToppingKeyboard(state) }
        });
    }

    if (data.startsWith('sel_top_')) {
        const id = data.replace('sel_top_', '');
        state.temp_item.topping_selected[id] = !state.temp_item.topping_selected[id];
        bot.editMessageReplyMarkup({ inline_keyboard: renderToppingKeyboard(state) }, { chat_id: chatId, message_id: q.message.message_id });
    }

    if (data === 'done_single_item') {
        state.temp_item.topping_ids = Object.keys(state.temp_item.topping_selected).filter(k => state.temp_item.topping_selected[k]);
        state.cart.push(state.temp_item);
        state.temp_item = null;
        if (state.pending_items.length > 0) {
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

    if (data.startsWith('opt_')) {
        state.dining_option = data.replace('opt_', '');
        state.step = 'INPUT_PHONE';
        bot.sendMessage(chatId, 'Bạn cho mình xin số điện thoại nha! 📞');
    }

    if (data === 'pay_cash' || data === 'pay_cod') {
        state.payment_status = data === 'pay_cash' ? 'cash' : 'cod';
        const orderText = buildFinalOrderText(state);
        bot.sendMessage(chatId, orderText);
        bot.sendMessage(chatId, 'Mình nhận đơn rồi nha! Đợi mình một xíu ❤️');
        notifyAdmin(orderText, false);
        delete userState[chatId];
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

async function processNextItemDetail(chatId) {
    const state = userState[chatId];
    const item = state.pending_items.shift();
    state.temp_item = Object.assign({}, item, { quantity: 1, topping_selected: {} });
    bot.sendMessage(chatId, 'Món ' + item.name + ' bạn lấy size nào', {
        reply_markup: {
            inline_keyboard: [[
                { text: 'Size M (' + formatMoney(item.price_m) + ')', callback_data: 'size_M' },
                { text: 'Size L (' + formatMoney(item.price_l) + ')', callback_data: 'size_L' }
            ]]
        }
    });
}

// WEBHOOK 
app.post('/payos-webhook', async (req, res) => {
    res.sendStatus(200); 

    try {
        if (req.body.desc === "confirm-webhook") {
            return console.log("✅ PayOS đã xác nhận Webhook thành công!");
        }
    
        const webhookData = payos.verifyWebhookData(req.body);
        const { orderCode, success } = webhookData;

        if (success && pendingOrders[orderCode]) {
            console.log(`✅ Đơn hàng ${orderCode} đã thanh toán thành công!`);
        }
    } catch (err) {
        console.error("❌ Lỗi xử lý Webhook:", err.message);
    }
});

loadData().then(() => app.listen(process.env.PORT || 3000, () => console.log('🚀 Bot Ready!')));
