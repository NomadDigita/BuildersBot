require('dotenv').config();
const fetch = require('node-fetch');
const express = require('express');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_IDS = process.env.CHAT_ID ? process.env.CHAT_ID.split(',') : [];
const PORT = process.env.PORT || 3000;

const CHECK_INTERVAL = 1 * 60 * 1000; 

let offset = 0;
let seenTasks = new Set(); 
let isFirstBoot = true;    

// 1. Initialize Render Health Check Server
const app = express();
app.get('/', (req, res) => res.send('BuildersWatcherBot is online.'));
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

// 3. Filtered & Sorted Bitget API Fetcher
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
    
    // Sort by ID descending (newest at the top)
    allTasks.sort((a, b) => {
        const idA = parseInt(String(a.id).replace(/\D/g, '')) || 0;
        const idB = parseInt(String(b.id).replace(/\D/g, '')) || 0;
        return idB - idA;
    });

    return allTasks.filter(task => {
        // RULE 1: Kill tasks where the due date has passed
        const dueStr = task.endTime || task.end_time || task.dueDate || task.deadline || task.due;
        if (dueStr) {
            const endMs = new Date(dueStr).getTime();
            if (endMs < Date.now()) return false; 
        }
        
        // RULE 2: Kill tasks explicitly marked as ended (NO MORE STRINGIFY SEARCH!)
        const statusStr = String(task.status || task.state || task.taskStatus || '').toLowerCase();
        if (statusStr === 'ended' || statusStr === 'completed' || statusStr === '2' || statusStr === '3') {
            return false;
        }

        // RULE 3: PUBLIC ONLY FILTER
        const category = String(task.taskCategory || task.team || '').toLowerCase();
        
        // Kill tasks explicitly labeled for Target Teams or Private
        if (category.includes('target') || category.includes('private')) {
            return false; 
        }
        
        // Kill tasks that are restricted to a whitelist of specific UIDs (Kills 1113 & 1112)
        if (Array.isArray(task.uids) && task.uids.length > 0) return false;
        if (Array.isArray(task.targetUids) && task.targetUids.length > 0) return false;

        return true; 
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

                if (!isFirstBoot) {
                    foundNewTask = true;
                    
                    const taskTitle = task.title || task.name || task.taskCategory || 'Untitled Campaign';
                    const due = task.endTime || task.end_time || task.dueDate || task.deadline || 'Time Not Specified';
                    const taskType = task.maxContent ? `Max Content: ${task.maxContent}` : (task.fcfs ? 'FCFS' : 'Open Task');

                    const message = `🚨 *NEW ONGOING TASK* 🚨\n\n` +
                                    `📌 *Title:* ${taskTitle}\n` +
                                    `🆔 *ID:* \`${task.id}\`\n` +
                                    `⏳ *Ends:* ${due}\n` +
                                    `⚡ *Type:* ${taskType}\n\n` +
                                    `🔗 [Execute on Builder Hub](https://www.bitgetbuilder.com/)`;

                    for (const chatId of CHAT_IDS) {
                        await sendMessage(chatId.trim(), message);
                    }
                }
            }
        }

        if (isFirstBoot) {
            console.log(`Stealth boot complete. Memorized ${seenTasks.size} active tasks.`);
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
        const startMenu = `⚡ *BuildersWatcherBot* ⚡\n\n` +
                          `I am built for scanning for new tasks on the [Bitget Builder Hub](https://www.bitgetbuilder.com/) to give immediate, quick, and sharp notice to connected builders.\n\n` +
                          `⚙️ *System Settings:*\n` +
                          `⏱️ *Auto Scan:* Every 1 minute\n` +
                          `🧹 *Data Filter:* Active (Ended & private tasks removed, open tasks only)\n\n` +
                          `🛠️ *Commands:*\n` +
                          `🔹 /start - View this setup menu and bot capabilities.\n` +
                          `🔹 /scan - Force an immediate manual check for live tasks.\n\n` +
                          `— @Asiwaju`;
                            
        await sendMessage(chatId, startMenu);
    } 
    
    else if (cleanText === '/scan') {
        await sendMessage(chatId, `🔍 *Scanning for ONGOING tasks only...*`);
        try {
            const activeTasks = await fetchCampaigns();
            
            if (activeTasks.length === 0) {
                await sendMessage(chatId, `⏸️ *Status:* Radar is clear. No active tasks available.`);
                return;
            }

            // SAFETY LOCK: Only process the first 15 tasks to prevent Telegram crashes
            const displayTasks = activeTasks.slice(0, 15);
            let reportMessage = `✅ *Active Ongoing Tasks Found (${activeTasks.length}):*\n\n`;
            
            for (const task of displayTasks) {
                const taskTitle = task.title || task.name || task.taskCategory || 'Untitled Task';
                const due = task.endTime || task.end_time || task.dueDate || task.deadline || 'Time Not Specified';
                const taskType = task.maxContent ? `Max Content: ${task.maxContent}` : (task.fcfs ? 'FCFS' : 'Open Task');

                reportMessage += `📌 *Title:* ${taskTitle}\n`;
                reportMessage += `🆔 *ID:* \`${task.id || 'N/A'}\`\n`;
                reportMessage += `⏳ *Ends:* ${due}\n`;
                reportMessage += `⚡ *Type:* ${taskType}\n\n`;
            }
            
            if (activeTasks.length > 15) {
                reportMessage += `*(...and ${activeTasks.length - 15} more hidden to save space)*\n\n`;
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