require('dotenv').config();
const fetch = require('node-fetch');
const express = require('express');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_IDS = process.env.CHAT_ID ? process.env.CHAT_ID.split(',') : [];
const PORT = process.env.PORT || 3000;

// High-frequency 1-minute interval
const CHECK_INTERVAL = 1 * 60 * 1000; 

let offset = 0;
let seenTasks = new Set(); // High-speed in-memory storage
let isFirstBoot = true;    // Stealth boot state

// 1. Initialize Render Health Check Server
const app = express();
app.get('/', (req, res) => res.send('Builders Watcher OS by @asiwajubtc is online.'));
app.listen(PORT, () => console.log(`Health check server listening on port ${PORT}`));

// 2. Telegram Message Engine
async function sendMessage(chatId, text) {
    const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
    try {
        await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                text: text,
                parse_mode: 'Markdown',
                disable_web_page_preview: true
            })
        });
    } catch (err) {
        console.error(`Failed to send message to ${chatId}:`, err.message);
    }
}

// 3. Filtered Bitget API Fetcher
async function fetchCampaigns() {
    const response = await fetch("https://api.bitgetbuilder.com/server/campaigns", {
        "headers": {
            "accept": "application/json, text/plain, */*",
            "accept-language": "en-US,en;q=0.9",
            "Referer": "https://www.bitgetbuilder.com/"
        },
        "method": "GET"
    });
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    const data = await response.json();
    
    let allTasks = Array.isArray(data.campaigns) ? data.campaigns : (Array.isArray(data) ? data : []);
    
    // STRICT FILTER: Keep only live/ongoing tasks. Ignore ended, completed, submitted, or expired ones.
    return allTasks.filter(task => {
        const status = String(task.status || task.state || task.taskStatus || '').toLowerCase();
        return status !== 'ended' && status !== 'submitted' && status !== 'completed' && status !== 'expired';
    });
}

// 4. Autonomous 1-Minute Scanner
async function scanTasksAutomatic() {
    console.log(`[${new Date().toLocaleTimeString()}] Running automated node scan...`);
    try {
        const activeTasks = await fetchCampaigns();
        let foundNewTask = false;

        for (const task of activeTasks) {
            if (task.id && !seenTasks.has(task.id)) {
                seenTasks.add(task.id);

                // Broadcast if not stealth booting
                if (!isFirstBoot) {
                    foundNewTask = true;
                    
                    const taskTitle = task.title || task.name || task.taskCategory || 'Untitled Campaign';
                    const taskTeam = task.team || task.assignedBy || 'N/A';
                    const maxContent = task.maxContent || task.fcfs || 'N/A';

                    const message = `🚨 *NEW PRIORITY TASK DEPLOYED* 🚨\n\n` +
                                    `📌 *Title:* ${taskTitle}\n` +
                                    `🆔 *Sys ID:* \`${task.id}\`\n` +
                                    `👥 *Division:* ${taskTeam}\n` +
                                    `⚡ *Capacity:* ${maxContent}\n\n` +
                                    `[Execute on Builder Hub](https://www.bitgetbuilder.com/)`;

                    for (const chatId of CHAT_IDS) {
                        await sendMessage(chatId.trim(), message);
                    }
                }
            }
        }

        if (isFirstBoot) {
            console.log(`Stealth boot complete. Memorized ${seenTasks.size} active tasks. Notifications armed.`);
            isFirstBoot = false; 
        } else if (!foundNewTask) {
            console.log('No new tasks found this cycle.');
        }

    } catch (error) {
        console.error('Scan failure:', error.message);
    }
}

// 5. Interactive Command Terminal
async function handleCommand(chatId, text) {
    const cleanText = text.trim().toLowerCase();

    if (cleanText === '/start') {
        const premiumMenu = `💎 *Builders Watcher OS | Elite Edition* 💎\n\n` +
                            `*System Status:* ONLINE 🟢\n` +
                            `*Authorized Commander:* Asiwaju (@asiwajubtc)\n\n` +
                            `High-frequency architectural node actively monitoring the Bitget Builder Hub for tier-1 opportunities.\n\n` +
                            `⚙️ *System Specifications:*\n` +
                            `⏱️ *Ping Rate:* 60,000ms (1 Minute)\n` +
                            `🔕 *Stealth Boot:* Active (Spam protection)\n` +
                            `🧹 *Data Filter:* Active (Dead tasks ignored)\n\n` +
                            `🛠️ *Available Directives:*\n` +
                            `🔹 /start - Launch OS Interface\n` +
                            `🔹 /scan - Request real-time index of live tasks`;
                            
        await sendMessage(chatId, premiumMenu);
    } 
    
    else if (cleanText === '/scan') {
        await sendMessage(chatId, `⏳ *Querying Bitget servers for live bounties...*`);
        try {
            const activeTasks = await fetchCampaigns();
            
            if (activeTasks.length === 0) {
                await sendMessage(chatId, `⏸️ *Status:* Radar is clear. No active tasks available.`);
                return;
            }

            // SAFETY LOCK: Only process the first 15 tasks so Telegram doesn't block the message
            const displayTasks = activeTasks.slice(0, 15);
            let reportMessage = `✅ *Active Tasks Found (${activeTasks.length}):*\n\n`;
            
            for (const task of displayTasks) {
                const taskTitle = task.title || task.name || task.taskCategory || 'Untitled Task';
                reportMessage += `📌 *${taskTitle}*\n🆔 \`${task.id || 'N/A'}\`\n\n`;
            }
            
            if (activeTasks.length > 15) {
                reportMessage += `*(...and ${activeTasks.length - 15} more older tasks hidden to save space)*\n\n`;
            }

            reportMessage += `🔗 [Access Builder Hub](https://www.bitgetbuilder.com/)`;
            
            await sendMessage(chatId, reportMessage);

        } catch (error) {
            await sendMessage(chatId, `❌ *Query Error:* ${error.message}`);
        }
    }
}

// 6. Long Polling Command Listener
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
                    if (CHAT_IDS.map(id => id.trim()).includes(chatId)) {
                        await handleCommand(chatId, update.message.text);
                    }
                }
            }
        }
    } catch (err) {
        console.error("Polling error:", err.message);
    }
    setTimeout(listenForCommands, 500);
}

// Boot Sequence Initialization
scanTasksAutomatic();              
setInterval(scanTasksAutomatic, CHECK_INTERVAL); 
listenForCommands();