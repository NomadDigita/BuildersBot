require('dotenv').config();
const fetch = require('node-fetch');
const express = require('express');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_IDS = process.env.CHAT_ID ? process.env.CHAT_ID.split(',') : [];
const PORT = process.env.PORT || 3000;

// UPGRADE: Changed to 1 minute
const CHECK_INTERVAL = 1 * 60 * 1000; 

let offset = 0;
let seenTasks = new Set(); // UPGRADE: In-memory storage replaces the JSON file
let isFirstBoot = true;    // UPGRADE: Silent boot flag

// 1. Initialize Dummy Web Server
const app = express();
app.get('/', (req, res) => res.send('Bitget Watcher Bot is running (1-min intervals).'));
app.listen(PORT, () => console.log(`Health check server listening on port ${PORT}`));

// 2. Telegram Message Helper
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

// 3. Fetch Campaigns API (Now with a filter for active tasks)
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
    
    // Grab the raw array
    let allTasks = Array.isArray(data.campaigns) ? data.campaigns : (Array.isArray(data) ? data : []);
    
    // Filter out ended tasks. (The Bitget API likely uses a 'status' field. We will keep anything that isn't explicitly 'ended' or 'submitted')
    let activeTasks = allTasks.filter(task => {
        const status = (task.status || '').toLowerCase();
        return status !== 'ended' && status !== 'submitted' && status !== 'completed';
    });

    return activeTasks;
}

// 4. 1-Minute Auto Scanner (Detailed & Silent on Boot)
async function scanTasksAutomatic() {
    console.log(`[${new Date().toLocaleTimeString()}] Running 1-minute auto scan...`);
    try {
        const dynamicTasks = await fetchCampaigns();
        let foundNewTask = false;

        for (const task of dynamicTasks) {
            if (task.id && !seenTasks.has(task.id)) {
                // Memorize the task ID
                seenTasks.add(task.id);

                // UPGRADE: Only send alerts if this is NOT the bot's first time waking up
                if (!isFirstBoot) {
                    foundNewTask = true;
                    
                    // Fallback to 'N/A' if the Bitget API uses slightly different keys for details
                    const taskTitle = task.title || task.name || task.taskCategory || 'Untitled Campaign';
                    const taskTeam = task.team || task.assignedBy || 'N/A';
                    const maxContent = task.maxContent || task.fcfs || 'N/A';

                    const message = `🚨 *New Bitget Builder Task!* 🚨\n\n` +
                                    `📌 *Name:* ${taskTitle}\n` +
                                    `🆔 *ID:* \`${task.id}\`\n` +
                                    `👥 *Team:* ${taskTeam}\n` +
                                    `⚡ *Limit/FCFS:* ${maxContent}\n\n` +
                                    `🔗 [Open Builder Hub](https://www.bitgetbuilder.com/)`;

                    for (const chatId of CHAT_IDS) {
                        await sendMessage(chatId.trim(), message);
                    }
                }
            }
        }

        // Handle the Boot State Logging
        if (isFirstBoot) {
            console.log(`Silent boot complete. Memorized ${seenTasks.size} existing tasks without spamming.`);
            isFirstBoot = false; // Turn off silent mode forever until next reboot
        } else if (!foundNewTask) {
            console.log('No new tasks found this minute.');
        }

    } catch (error) {
        console.error('Automatic scan failed:', error.message);
    }
}

// 5. Handle Incoming Commands
async function handleCommand(chatId, text) {
    const cleanText = text.trim().toLowerCase();

    if (cleanText === '/start') {
        const welcomeMessage = `⚡ *BuildersWatcherBot Ready* ⚡\n\n` +
                               `I am an automated task tracker monitoring the *Bitget Builder Hub*.\n\n` +
                               `⚙️ *Settings:* \n` +
                               `• *Auto Scan:* Every 1 minute.\n` +
                               `• *Silent Boot:* Enabled (No spam on server restart).\n\n` +
                               `🛠️ *Commands:* \n` +
                               `• /start - View this menu.\n` +
                               `• /scan - View a clean list of currently available tasks.`;
        await sendMessage(chatId, welcomeMessage);
    } 
    
    else if (cleanText === '/scan') {
        await sendMessage(chatId, `🔍 *Checking live tasks...*`);
        try {
            const dynamicTasks = await fetchCampaigns();
            
            if (dynamicTasks.length === 0) {
                await sendMessage(chatId, `⏸️ *Status:* There are no active tasks right now.`);
                return;
            }

            // UPGRADE: Simple layout just for manual scanning
            let reportMessage = `✅ *Live Campaigns Available:*\n\n`;
            for (const task of dynamicTasks) {
                const taskTitle = task.title || task.name || task.taskCategory || 'Untitled Task';
                reportMessage += `📌 *${taskTitle}*\n🆔 \`${task.id || 'N/A'}\`\n\n`;
            }
            reportMessage += `🔗 [Check Manually](https://www.bitgetbuilder.com/)`;
            await sendMessage(chatId, reportMessage);

        } catch (error) {
            await sendMessage(chatId, `❌ *Error:* ${error.message}`);
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

// Boot Sequence
scanTasksAutomatic();              // Run silent boot scan immediately
setInterval(scanTasksAutomatic, CHECK_INTERVAL); // Start 1-minute loop
listenForCommands();               // Listen for /scan and /start