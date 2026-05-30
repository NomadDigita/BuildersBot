require('dotenv').config();
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const express = require('express');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_IDS = process.env.CHAT_ID ? process.env.CHAT_ID.split(',') : [];
const PORT = process.env.PORT || 3000;
const CHECK_INTERVAL = 5 * 60 * 1000; // 5 minutes
const CACHE_FILE = path.join(__dirname, 'past_tasks.json');

let offset = 0; // Tracks Telegram message updates

// 1. Initialize Dummy Web Server for Render Health Checks
const app = express();
app.get('/', (req, res) => res.send('Bitget Watcher Bot is running cleanly with commands enabled.'));
app.listen(PORT, () => console.log(`Health check server listening on port ${PORT}`));

// 2. Ensure cache file exists
if (!fs.existsSync(CACHE_FILE)) {
    fs.writeFileSync(CACHE_FILE, JSON.stringify([]));
}

// 3. Helper to send a direct message to a specific user
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

// 4. Fetch Campaigns from Bitget Builder API
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
    return Array.isArray(data) ? data : (data.data || []);
}

// 5. Automatic Broadcast Task Scanner (Runs every 5 minutes)
async function scanTasksAutomatic() {
    console.log(`[${new Date().toLocaleTimeString()}] Running automatic background scan...`);
    try {
        const dynamicTasks = await fetchCampaigns();
        let seenTasks = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
        let foundNewTask = false;

        for (const task of dynamicTasks) {
            if (task.id && !seenTasks.includes(task.id)) {
                seenTasks.push(task.id);
                foundNewTask = true;

                // Broadcast to all connected builders
                const message = `🚨 *New Bitget Builder Task Available!* 🚨\n\n` +
                                `📌 *Title:* ${task.title || 'Untitled Campaign'}\n` +
                                `🆔 *ID:* ${task.id || 'N/A'}\n\n` +
                                `🔗 [Open Builder Hub](https://www.bitgetbuilder.com/)`;

                for (const chatId of CHAT_IDS) {
                    await sendMessage(chatId.trim(), message);
                }
            }
        }

        if (foundNewTask) {
            fs.writeFileSync(CACHE_FILE, JSON.stringify(seenTasks, null, 2));
        } else {
            console.log('No new tasks found during background scan.');
        }
    } catch (error) {
        console.error('Automatic scan failed:', error.message);
    }
}

// 6. Handle Incoming Commands (/start and /scan)
async function handleCommand(chatId, text) {
    const cleanText = text.trim().toLowerCase();

    if (cleanText === '/start') {
        const welcomeMessage = `⚡ *Welcome to BuildersWatcherBot!* ⚡\n\n` +
                               `I am a sharp, high-speed automated task tracker built solely to monitor the *Bitget Builder Hub* for new opportunities.\n\n` +
                               `⚙️ *What I do:* \n` +
                               `• *Auto Scanning:* I check the API every 5 minutes and instantly broadcast new tasks to all connected builders.\n` +
                               `• *Manual Control:* You can request an instant real-time lookup whenever you want.\n\n` +
                               `🛠️ *Available Commands:* \n` +
                               `• /start - View this setup menu and bot capabilities.\n` +
                               `• /scan - Force an immediate, real-time manual check for live tasks.`;
        await sendMessage(chatId, welcomeMessage);
    } 
    
    else if (cleanText === '/scan') {
        await sendMessage(chatId, `🔍 *Initiating immediate manual scan...*`);
        try {
            const dynamicTasks = await fetchCampaigns();
            
            if (dynamicTasks.length === 0) {
                await sendMessage(chatId, `⏸️ *Status:* There are no ongoing campaigns or available tasks at the moment.\n\n🔗 [Check Manually](https://www.bitgetbuilder.com/)`);
                return;
            }

            let reportMessage = `✅ *Live Campaigns Found!*\n\nHere are the tasks currently active on the dashboard:\n\n`;
            for (const task of dynamicTasks) {
                reportMessage += `📌 *Title:* ${task.title || 'Untitled Campaign'}\n🆔 *ID:* \`${task.id || 'N/A'}\`\n\n`;
            }
            reportMessage += `🔗 [Open Builder Hub](https://www.bitgetbuilder.com/)`;
            await sendMessage(chatId, reportMessage);

        } catch (error) {
            await sendMessage(chatId, `❌ *Error processing manual scan:* ${error.message}`);
        }
    }
}

// 7. Long Polling Engine to Listen for Telegram Messages
async function listenForCommands() {
    const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/getUpdates?offset=${offset}&timeout=30`;
    try {
        const response = await fetch(url);
        if (!response.ok) return setTimeout(listenForCommands, 5000); // Wait and retry on error

        const data = await response.json();
        if (data.ok && data.result.length > 0) {
            for (const update of data.result) {
                offset = update.update_id + 1; // Increment offset so we don't process this message again
                
                if (update.message && update.message.text) {
                    const chatId = update.message.chat.id.toString();
                    
                    // Check if the user is authorized in your CHAT_ID whitelist
                    if (CHAT_IDS.map(id => id.trim()).includes(chatId)) {
                        await handleCommand(chatId, update.message.text);
                    } else {
                        // Optional: Alert unauthorized users
                        await sendMessage(chatId, "⚠️ You are not authorized to use this bot instance.");
                    }
                }
            }
        }
    } catch (err) {
        console.error("Polling error:", err.message);
    }
    // Re-call immediately to maintain open polling pipe
    setTimeout(listenForCommands, 500);
}

// Start Engines
scanTasksAutomatic();              // Run once on launch
setInterval(scanTasksAutomatic, CHECK_INTERVAL); // Schedule auto scan
listenForCommands();               // Boot command listener loop