require('dotenv').config();
const fetch = require('node-fetch'); 
const express = require('express');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_IDS = process.env.CHAT_ID ? process.env.CHAT_ID.split(',').map(id => id.trim()) : [];
const PORT = process.env.PORT || 3000;

// WhatsApp configuration variables
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || '';
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || '';
const WHATSAPP_RECIPIENTS = process.env.WHATSAPP_RECIPIENTS ? process.env.WHATSAPP_RECIPIENTS.split(',').map(num => num.trim()) : [];
const WHATSAPP_VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || 'my_secure_token'; 

// Render automatically injects this environment variable in Web Services
const RENDER_EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL || ''; 

// Configurable Task Filter: 'automatic', 'manual', or 'both'
const TASK_CHECK_TYPE = (process.env.TASK_CHECK_TYPE || 'both').toLowerCase().trim();

const SESSION_COOKIE = process.env.SESSION_COOKIE || '';
const AUTHORIZATION_HEADER = process.env.AUTHORIZATION || '';

if (!TELEGRAM_TOKEN) {
    console.error("CRITICAL ERROR: TELEGRAM_TOKEN is missing from your .env file.");
    process.exit(1);
}

const CHECK_INTERVAL = 10 * 1000; 

let offset = 0;
let seenTasks = new Set(); 
let isFirstBoot = true;    

function escapeHTML(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

// Formats Telegram HTML templates into native WhatsApp formatting
function convertToWhatsAppFormat(htmlText) {
    let text = htmlText;
    text = text.replace(/<a href="([^"]+)">([^<]+)<\/a>/g, '$2 ($1)');
    text = text.replace(/<\/?b>/g, '*');
    text = text.replace(/<\/?code>/g, '`');
    text = text.replace(/<\/?i>/g, '_');
    return text;
}

// Robust ISO-8601 timezone parser to support exact offsets like (GMT+8)
function parseTaskDate(dateStr) {
    if (!dateStr) return 0;
    
    const tzMatch = String(dateStr).match(/\(GMT([+-]\d+)\)/i);
    let cleanStr = String(dateStr).replace(/\(GMT[+-]\d+\)/i, '').trim();
    const normalized = cleanStr.replace(/\//g, '-').replace(' ', 'T');
    
    if (tzMatch) {
        const offsetNum = parseInt(tzMatch[1], 10);
        const sign = offsetNum >= 0 ? '+' : '-';
        const absoluteOffset = Math.abs(offsetNum);
        const formattedOffset = `${sign}${String(absoluteOffset).padStart(2, '0')}:00`;
        
        const isoString = `${normalized}:00${formattedOffset}`;
        const parsed = Date.parse(isoString);
        return isNaN(parsed) ? 0 : parsed;
    }
    
    const parsed = Date.parse(normalized);
    return isNaN(parsed) ? 0 : parsed;
}

// Generates a professional countdown string
function getCountdownString(deadlineStr) {
    const deadlineMs = parseTaskDate(deadlineStr);
    if (!deadlineMs) return 'Not Specified';
    
    const diffMs = deadlineMs - Date.now();
    if (diffMs <= 0) return 'Ended';

    const diffMins = Math.floor(diffMs / (1000 * 60));
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);

    const remainingHours = diffHours % 24;
    const remainingMins = diffMins % 60;

    let parts = [];
    if (diffDays > 0) {
        parts.push(`${diffDays}d`);
    }
    if (remainingHours > 0 || diffDays > 0) {
        parts.push(`${remainingHours}h`);
    }
    parts.push(`${remainingMins}m`);

    return parts.join(' ');
}

// Initialize Render Web Server
const app = express();
app.use(express.json()); 

app.get('/', (req, res) => res.send('BuildersWatcherBot is online.'));

// 1. WhatsApp Webhook Verification Handshake (GET)
app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === WHATSAPP_VERIFY_TOKEN) {
        console.log('[WhatsApp Webhook] Verification successful!');
        res.status(200).send(challenge);
    } else {
        console.warn('[WhatsApp Webhook] Verification token mismatch.');
        res.sendStatus(403);
    }
});

// 2. WhatsApp Incoming Webhook Message Handler (POST)
app.post('/webhook', async (req, res) => {
    const body = req.body;

    if (body.object === 'whatsapp_business_account') {
        try {
            if (body.entry && body.entry[0].changes && body.entry[0].changes[0].value.messages) {
                const message = body.entry[0].changes[0].value.messages[0];
                const fromNumber = message.from; 
                
                if (WHATSAPP_RECIPIENTS.includes(fromNumber)) {
                    if (message.type === 'text') {
                        const text = message.text.body.trim().toLowerCase();
                        await handleWhatsAppCommand(fromNumber, text);
                    }
                } else {
                    console.log(`[WhatsApp Webhook] Message from unauthorized number ignored: ${fromNumber}`);
                }
            }
        } catch (err) {
            console.error('[WhatsApp Webhook] Parsing error:', err.message);
        }
        res.sendStatus(200);
    } else {
        res.sendStatus(404);
    }
});

app.listen(PORT, () => console.log(`Health check server listening on port ${PORT}`));

// Self-Pinger to bypass Render's Free Tier sleep policy
function startSelfPinger() {
    if (RENDER_EXTERNAL_URL) {
        console.log(`[Keep-Alive] Self-Pinger activated targeting: ${RENDER_EXTERNAL_URL}`);
        setInterval(() => {
            console.log(`[Keep-Alive] Sending self-ping...`);
            fetch(RENDER_EXTERNAL_URL)
                .then(res => console.log(`[Keep-Alive] Self-ping successful: HTTP ${res.status}`))
                .catch(err => console.error(`[Keep-Alive] Self-ping failed:`, err.message));
        }, 10 * 60 * 1000); 
    } else {
        console.warn("[Keep-Alive] RENDER_EXTERNAL_URL is not set. Self-pinger disabled.");
    }
}

// Telegram Message Engine
async function sendMessage(chatId, text) {
    const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                text: text,
                parse_mode: 'HTML',
                disable_web_page_preview: true
            })
        });
        if (!response.ok) {
            const errBody = await response.json();
            console.error(`Telegram API Error for Chat ${chatId}:`, errBody);
        }
    } catch (err) {
        console.error(`Failed to send message to ${chatId}:`, err.message);
    }
}

// WhatsApp Outbound Message Engine (UPDATED: API endpoint targeted to v25.0)
async function sendWhatsAppMessage(to, text) {
    if (!WHATSAPP_TOKEN || !WHATSAPP_PHONE_NUMBER_ID) return;
    
    const url = `https://graph.facebook.com/v25.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`;
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                messaging_product: "whatsapp",
                recipient_type: "individual",
                to: to,
                type: "text",
                text: {
                    preview_url: false,
                    body: text
                }
            })
        });
        
        if (!response.ok) {
            const errData = await response.json();
            console.error(`WhatsApp API Error for ${to}:`, JSON.stringify(errData));
        } else {
            console.log(`WhatsApp notification successfully sent to ${to}`);
        }
    } catch (err) {
        console.error(`Failed to send WhatsApp message to ${to}:`, err.message);
    }
}

// Strict UID Checker matching the API schema
function hasSpecificUIDs(task) {
    const autoUids = task.autoSelectedUIDs;
    if (autoUids) {
        if (Array.isArray(autoUids) && autoUids.length > 0) return true;
        if (typeof autoUids === 'string' && autoUids.trim().length > 0) return true;
    }
    
    const manualUids = task.manualSelectedUIDs;
    if (manualUids) {
        if (Array.isArray(manualUids) && manualUids.length > 0) return true;
        if (typeof manualUids === 'string' && manualUids.trim().length > 0) return true;
    }

    if (task.manualSelected === true) return true;

    return false;
}

// Check Type Matcher
function matchesTaskCheckType(task) {
    if (TASK_CHECK_TYPE === 'both') return true;

    const isAutoCheck = task.autoSelectedUIDs !== undefined || 
                        String(task.taskCategory || '').toLowerCase().includes('auto');

    if (TASK_CHECK_TYPE === 'automatic') return isAutoCheck;
    if (TASK_CHECK_TYPE === 'manual') return !isAutoCheck;

    return true;
}

// Fetch helper with headers
async function fetchRawCampaigns() {
    const headers = {
        "accept": "application/json, text/plain, */*",
        "accept-language": "en-US,en;q=0.9",
        "Referer": "https://www.bitgetbuilder.com/",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    };

    if (SESSION_COOKIE) headers["cookie"] = SESSION_COOKIE;
    if (AUTHORIZATION_HEADER) headers["authorization"] = AUTHORIZATION_HEADER;

    const response = await fetch("https://api.bitgetbuilder.com/server/campaigns", {
        "headers": headers,
        "method": "GET"
    });
    
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    const data = await response.json();
    
    return Array.isArray(data.campaigns) ? data.campaigns : (Array.isArray(data) ? data : []);
}

// Filter Engine
async function fetchCampaigns() {
    const allTasks = await fetchRawCampaigns();
    
    allTasks.sort((a, b) => {
        const timeA = parseTaskDate(a.deadline);
        const timeB = parseTaskDate(b.deadline);
        return timeB - timeA;
    });

    return allTasks.filter(task => {
        const dueStr = task.deadline;
        if (dueStr) {
            const endMs = parseTaskDate(dueStr);
            if (endMs !== 0 && endMs < Date.now()) return false; 
        }

        const titleStr = String(task.title || '').toLowerCase();
        const teamStr = String(task.targetTeam || task.targetLabel || '').toLowerCase();

        if (titleStr.includes('(cmc)') || 
            titleStr.includes('winner') || 
            titleStr.includes('reddit') || 
            teamStr.includes('target') || 
            teamStr.includes('private')) {
            return false; 
        }

        const isTargetedGroup = teamStr === '' || 
                               teamStr === 'none' || 
                               teamStr === 'null' || 
                               teamStr.includes('core') || 
                               teamStr.includes('trainee') || 
                               teamStr.includes('vip') || 
                               teamStr.includes('everyone') || 
                               teamStr.includes('open');

        if (!isTargetedGroup) return false; 
        if (hasSpecificUIDs(task)) return false;
        if (!matchesTaskCheckType(task)) return false;

        return true; 
    });
}

// In-Chat Diagnostic Generator
async function getTaskFilteringReport() {
    try {
        const allTasks = await fetchRawCampaigns();
        
        if (allTasks.length === 0) {
            return `⚠️ <b>API returned 0 tasks.</b>\n\nEnsure your session cookie is correctly added in Render.`;
        }

        allTasks.sort((a, b) => {
            const timeA = parseTaskDate(a.deadline);
            const timeB = parseTaskDate(b.deadline);
            return timeB - timeA;
        });

        let report = `📊 <b>Diagnostic Filter Report (Sorted by Deadline)</b>\n`;
        report += `Total Raw Tasks Fetched: <b>${allTasks.length}</b>\n\n`;

        const sampleTasks = allTasks.slice(0, 5);
        for (const task of sampleTasks) {
            const taskId = task.id || 'N/A';
            const title = task.title || 'Untitled';
            let status = "✅ PASSED";
            let reason = "";

            const dueStr = task.deadline;
            if (dueStr) {
                const endMs = parseTaskDate(dueStr);
                if (endMs !== 0 && endMs < Date.now()) {
                    status = "❌ SKIPPED";
                    reason = `Time expired (${dueStr})`;
                }
            }

            const teamStr = String(task.targetTeam || task.targetLabel || '').toLowerCase();
            if (status === "✅ PASSED") {
                const isTargetedGroup = teamStr === '' || teamStr === 'none' || teamStr === 'null' || teamStr.includes('core') || teamStr.includes('trainee') || teamStr.includes('vip') || teamStr.includes('everyone') || teamStr.includes('open');
                if (!isTargetedGroup) {
                    status = "❌ SKIPPED";
                    reason = `Not whitelisted role (Team: "${teamStr}")`;
                }
            }

            if (status === "✅ PASSED" && hasSpecificUIDs(task)) {
                status = "❌ SKIPPED";
                reason = `UID restriction detected`;
            }

            if (status === "✅ PASSED" && !matchesTaskCheckType(task)) {
                status = "❌ SKIPPED";
                reason = `Check type mismatches filter`;
            }

            report += `🔹 <b>[ID: ${taskId}]</b> ${escapeHTML(title.substring(0, 30))}...\n`;
            report += `Result: ${status} ${reason ? `(${reason})` : ''}\n\n`;
        }

        return report;
    } catch (err) {
        return `❌ <b>Diagnostic Error:</b> ${escapeHTML(err.message)}`;
    }
}

// Autonomous Scanner (Runs on interval)
async function scanTasksAutomatic() {
    console.log(`[${new Date().toLocaleTimeString()}] Running automated node scan...`);
    try {
        const activeTasks = await fetchCampaigns();
        let foundNewTask = false;

        for (const task of activeTasks) {
            if (task.id && !seenTasks.has(task.id)) {
                seenTasks.add(task.id);

                if (!isFirstBoot) {
                    foundNewTask = true;
                    
                    const taskTitle = task.title || 'Untitled Campaign';
                    const due = task.deadline || 'Time Not Specified';
                    const taskType = task.maxContent ? `Max Content: ${task.maxContent}` : 'Open Task';
                    const countdown = getCountdownString(due);

                    const message = `🚨 <b>NEW ONGOING TASK</b> 🚨\n\n` +
                                    `📌 <b>Title:</b> ${escapeHTML(taskTitle)}\n` +
                                    `🆔 <b>ID:</b> <code>${task.id}</code>\n` +
                                    `⏳ <b>Ends:</b> ${escapeHTML(due)}\n` +
                                    `⏱️ <b>Time Left:</b> <code>${countdown}</code>\n` +
                                    `⚡ <b>Type:</b> ${escapeHTML(taskType)}\n\n` +
                                    `🔗 <a href="https://www.bitgetbuilder.com/">Execute on Builder Hub</a>`;

                    // Deliver message to Telegram Channels
                    for (const chatId of CHAT_IDS) {
                        await sendMessage(chatId, message);
                    }

                    // Deliver formatted message to WhatsApp Recipients
                    if (WHATSAPP_RECIPIENTS.length > 0) {
                        const waFormattedMsg = convertToWhatsAppFormat(message);
                        for (const number of WHATSAPP_RECIPIENTS) {
                            await sendWhatsAppMessage(number, waFormattedMsg);
                        }
                    }
                }
            }
        }

        if (isFirstBoot) {
            console.log(`Stealth boot complete. Memorized ${seenTasks.size} active open tasks.`);
            isFirstBoot = false; 
        } else if (!foundNewTask) {
            console.log('No new tasks found this cycle.');
        }

    } catch (error) {
        console.error('Scan failure:', error.message);
    }
}

// Telegram Command Router
async function handleCommand(chatId, text) {
    const cleanText = text.trim().toLowerCase();

    if (cleanText === '/start') {
        const startMenu = `⚡ <b>BuildersWatcherBot</b> ⚡\n\n` +
                          `⚙️ <b>System Settings:</b>\n` +
                          `⏱️ <b>Auto Scan:</b> Every 10 seconds\n` +
                          `🧹 <b>Filter Mode:</b> Active (Role: Core/Trainee/VIP, Type: ${TASK_CHECK_TYPE.toUpperCase()}, Whitelisted UIDs: Excluded)\n\n` +
                          `🛠️ <b>Commands:</b>\n` +
                          `🔹 /start - View setup menu.\n` +
                          `🔹 /scan - Force an immediate manual check for live tasks.`;
                            
        await sendMessage(chatId, startMenu);
    } 
    
    else if (cleanText === '/scan') {
        await sendMessage(chatId, `🔍 <b>Scanning for ONGOING tasks...</b>`);
        try {
            const activeTasks = await fetchCampaigns();
            
            if (activeTasks.length === 0) {
                const diagnosticReport = await getTaskFilteringReport();
                await sendMessage(chatId, `⏸️ <b>Status:</b> Radar is clear. No active open tasks match.\n\n${diagnosticReport}`);
                return;
            }

            const displayTasks = activeTasks.slice(0, 15);
            let reportMessage = `✅ <b>Active Ongoing Tasks Found (${activeTasks.length}):</b>\n\n`;
            
            for (const task of displayTasks) {
                const taskTitle = task.title || 'Untitled Task';
                const due = task.deadline || 'Time Not Specified';
                const taskType = task.maxContent ? `Max Content: ${task.maxContent}` : 'Open Task';
                const countdown = getCountdownString(due);

                reportMessage += `📌 <b>Title:</b> ${escapeHTML(taskTitle)}\n`;
                reportMessage += `🆔 <b>ID:</b> <code>${task.id || 'N/A'}</code>\n`;
                reportMessage += `⏳ <b>Ends:</b> ${escapeHTML(due)}\n`;
                reportMessage += `⏱️ <b>Time Left:</b> <code>${countdown}</code>\n`;
                reportMessage += `⚡ <b>Type:</b> ${escapeHTML(taskType)}\n\n`;
            }
            
            if (activeTasks.length > 15) {
                reportMessage += `<i>(...and ${activeTasks.length - 15} more hidden to save space)</i>\n\n`;
            }

            reportMessage += `🔗 <a href="https://www.bitgetbuilder.com/">Access Builder Hub</a>`;
            await sendMessage(chatId, reportMessage);

        } catch (error) {
            await sendMessage(chatId, `❌ <b>Query Error:</b> ${escapeHTML(error.message)}`);
        }
    }
}

// WhatsApp Command Router (Processes incoming text from the Webhook)
async function handleWhatsAppCommand(fromNumber, text) {
    const cleanText = text.trim().toLowerCase();

    if (cleanText === 'scan') {
        await sendWhatsAppMessage(fromNumber, `🔍 *Scanning for ONGOING tasks...*`);
        try {
            const activeTasks = await fetchCampaigns();
            
            if (activeTasks.length === 0) {
                const diagnosticReport = await getTaskFilteringReport();
                const waDiag = convertToWhatsAppFormat(diagnosticReport);
                await sendWhatsAppMessage(fromNumber, `⏸️ *Status:* Radar is clear. No active open tasks match.\n\n${waDiag}`);
                return;
            }

            const displayTasks = activeTasks.slice(0, 15);
            let reportMessage = `✅ *Active Ongoing Tasks Found (${activeTasks.length}):*\n\n`;
            
            for (const task of displayTasks) {
                const taskTitle = task.title || 'Untitled Task';
                const due = task.deadline || 'Time Not Specified';
                const taskType = task.maxContent ? `Max Content: ${task.maxContent}` : 'Open Task';
                const countdown = getCountdownString(due);

                reportMessage += `📌 *Title:* ${taskTitle}\n`;
                reportMessage += `🆔 *ID:* \`${task.id || 'N/A'}\`\n`;
                reportMessage += `⏳ *Ends:* ${due}\n`;
                reportMessage += `⏱ *Time Left:* \`${countdown}\`\n`;
                reportMessage += `⚡ *Type:* ${taskType}\n\n`;
            }
            
            if (activeTasks.length > 15) {
                reportMessage += `_(...and ${activeTasks.length - 15} more hidden to save space)_\n\n`;
            }

            reportMessage += `🔗 *Access Builder Hub (https://www.bitgetbuilder.com/)*`;
            await sendWhatsAppMessage(fromNumber, reportMessage);

        } catch (error) {
            await sendWhatsAppMessage(fromNumber, `❌ *Query Error:* ${error.message}`);
        }
    } else {
        const helpMenu = `⚡ *BuildersWatcherBot* ⚡\n\n` +
                         `Type *scan* to force an immediate manual check for live tasks.`;
        await sendWhatsAppMessage(fromNumber, helpMenu);
    }
}

// Long Polling Telegram Command Listener
async function listenForCommands() {
    const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/getUpdates?offset=${offset}&timeout=30`;
    try {
        const response = await fetch(url);
        if (!response.ok) return setTimeout(listenForCommands, 5000);

        const data = await response.json();
        if (data.ok && data.result.length > 0) {
            for (const update of data.result) {
                offset = update.update_id + 1; 
                if (update.message && update.message.text) {
                    const chatId = update.message.chat.id.toString();
                    if (CHAT_IDS.includes(chatId)) {
                        await handleCommand(chatId, update.message.text);
                    } else {
                        console.log(`[Diagnostic] Unauthorized Chat ID: "${chatId}"`);
                    }
                }
            }
        }
    } catch (err) {
        console.error("Polling error:", err.message);
    }
    setTimeout(listenForCommands, 500);
}

scanTasksAutomatic();              
setInterval(scanTasksAutomatic, CHECK_INTERVAL); 
listenForCommands();

// Start Self-Pinger for 24/7 runtime
startSelfPinger();
