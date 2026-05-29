require('dotenv').config();
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const express = require('express');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
// Split the comma-separated string into an array of clean IDs
const CHAT_IDS = process.env.CHAT_ID ? process.env.CHAT_ID.split(',') : [];
const PORT = process.env.PORT || 3000;
const CHECK_INTERVAL = 5 * 60 * 1000; // 5 minutes
const CACHE_FILE = path.join(__dirname, 'past_tasks.json');

// 1. Initialize Dummy Web Server for Render Health Checks
const app = express();
app.get('/', (req, res) => res.send('Bitget Watcher Bot is running cleanly.'));
app.listen(PORT, () => console.log(`Health check server listening on port ${PORT}`));

// 2. Ensure cache file exists
if (!fs.existsSync(CACHE_FILE)) {
    fs.writeFileSync(CACHE_FILE, JSON.stringify([]));
}

// 3. Notification Engine (Modified to accept a specific chat ID)
async function sendNotification(task, chatId) {
    const message = `🚨 *New Bitget Builder Task Available!* 🚨\n\n` +
                    `📌 *Title:* ${task.title || 'Untitled Campaign'}\n` +
                    `🆔 *ID:* ${task.id || 'N/A'}\n\n` +
                    `🔗 [Open Builder Hub](https://www.bitgetbuilder.com/)`;

    const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
    
    try {
        await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId.trim(), // Remove any accidental spaces
                text: message,
                parse_mode: 'Markdown',
                disable_web_page_preview: true
            })
        });
        console.log(`Notification sent cleanly to account: ${chatId.trim()}`);
    } catch (err) {
        console.error(`Error sending Telegram notification to ${chatId}:`, err);
    }
}

// 4. Core Scanning Logic
async function scanTasks() {
    console.log(`[${new Date().toLocaleTimeString()}] Scanning Bitget Builder...`);
    try {
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
        const dynamicTasks = Array.isArray(data) ? data : (data.data || []);
        
        let seenTasks = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
        let foundNewTask = false;

        for (const task of dynamicTasks) {
            if (task.id && !seenTasks.includes(task.id)) {
                seenTasks.push(task.id);
                
                // Loop through all registered Telegram accounts for this task
                for (const chatId of CHAT_IDS) {
                    await sendNotification(task, chatId);
                }
                foundNewTask = true;
            }
        }

        if (foundNewTask) {
            fs.writeFileSync(CACHE_FILE, JSON.stringify(seenTasks, null, 2));
        } else {
            console.log('No new tasks found.');
        }
    } catch (error) {
        console.error('Fetch operation failed:', error.message);
    }
}

// Start Scheduler
scanTasks();
setInterval(scanTasks, CHECK_INTERVAL);