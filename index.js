require('dotenv').config();
const express = require('express');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
// Pre-trim all IDs to avoid whitespace issues
const CHAT_IDS = process.env.CHAT_ID ? process.env.CHAT_ID.split(',').map(id => id.trim()) : [];
const PORT = process.env.PORT || 3000;

// Validate critical environmental keys at startup
if (!TELEGRAM_TOKEN) {
    console.error("CRITICAL ERROR: TELEGRAM_TOKEN is missing from your .env file.");
    process.exit(1);
}

const CHECK_INTERVAL = 1 * 60 * 1000; 

let offset = 0;
let seenTasks = new Set(); 
let isFirstBoot = true;    

// HTML Escape helper to prevent Telegram parsing engine crashes
function escapeHTML(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

// 1. Initialize Render Health Check Server
const app = express();
app.get('/', (req, res) => res.send('BuildersWatcherBot is online.'));
app.listen(PORT, () => console.log(`Health check server listening on port ${PORT}`));

// 2. Telegram Message Engine (HTML Parse Mode)
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
        // RULE 1: Time Check
        const dueStr = task.endTime || task.end_time || task.dueDate || task.deadline || task.due;
        if (dueStr) {
            const cleanDateStr = String(dueStr).replace(/\(GMT[+-]\d+\)/i, '').trim();
            const endMs = new Date(cleanDateStr).getTime();
            if (!isNaN(endMs) && endMs < Date.now()) return false; 
        }

        // RULE 2: Status Check
        const statusStr = String(task.status || task.state || task.taskStatus || '').toLowerCase();
        if (statusStr === 'ended' || statusStr === 'completed') {
            return false;
        }

        // RULE 3: THE EXPLICIT BLACKLIST
        const titleStr = String(task.title || task.name || '').toLowerCase();
        const teamStr = String(task.team || task.taskCategory || '').toLowerCase().trim();
        const taskStr = JSON.stringify(task).toLowerCase();

        if (titleStr.includes('(cmc)') || 
            titleStr.includes('winner') || 
            titleStr.includes('reddit') || 
            teamStr.includes('target') || 
            taskStr.includes('"target team"') || 
            taskStr.includes('private')) {
            return false; 
        }

        // RULE 4: THE STRICT PUBLIC WHITELIST
        const isPublic = teamStr === '' || 
                         teamStr === 'none' || 
                         teamStr === 'null' || 
                         teamStr.includes('core') || 
                         teamStr.includes('trainee') || 
                         teamStr.includes('vip') || 
                         teamStr.includes('everyone') || 
                         teamStr.includes('open');

        if (!isPublic) {
            return false; 
        }

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

                    const message = `🚨 <b>NEW ONGOING TASK</b> 🚨\n\n` +
                                    `📌 <b>Title:</b> ${escapeHTML(taskTitle)}\n` +
                                    `🆔 <b>ID:</b> <code>${task.id}</code>\n` +
                                    `⏳ <b>Ends:</b> ${escapeHTML(due)}\n` +
                                    `⚡ <b>Type:</b> ${escapeHTML(taskType)}\n\n` +
                                    `🔗 <a href="https://www.bitgetbuilder.com/">Execute on Builder Hub</a>`;

                    for (const chatId of CHAT_IDS) {
                        await sendMessage(chatId, message);
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

// 5. Interactive Command Terminal
async function handleCommand(chatId, text) {
    const cleanText = text.trim().toLowerCase();

    if (cleanText === '/start') {
        const startMenu = `⚡ <b>BuildersWatcherBot</b> ⚡\n\n` +
                          `I am built for scanning for new tasks on the <a href="https://www.bitgetbuilder.com/">Bitget Builder Hub</a> to give immediate, quick, and sharp notice to connected builders.\n\n` +
                          `⚙️ <b>System Settings:</b>\n` +
                          `⏱️ <b>Auto Scan:</b> Every 1 minute\n` +
                          `🧹 <b>Data Filter:</b> Active (Ended & private tasks removed, open tasks only)\n\n` +
                          `🛠️ <b>Commands:</b>\n` +
                          `🔹 /start - View this setup menu and bot capabilities.\n` +
                          `🔹 /scan - Force an immediate manual check for live tasks.`;
                            
        await sendMessage(chatId, startMenu);
    } 
    
    else if (cleanText === '/scan') {
        await sendMessage(chatId, `🔍 <b>Scanning for ONGOING tasks only...</b>`);
        try {
            const activeTasks = await fetchCampaigns();
            
            if (activeTasks.length === 0) {
                await sendMessage(chatId, `⏸️ <b>Status:</b> Radar is clear. No active tasks available.`);
                return;
            }

            // SAFETY LOCK: Only process the first 15 tasks to prevent Telegram crashes
            const displayTasks = activeTasks.slice(0, 15);
            let reportMessage = `✅ <b>Active Ongoing Tasks Found (${activeTasks.length}):</b>\n\n`;
            
            for (const task of displayTasks) {
                const taskTitle = task.title || task.name || task.taskCategory || 'Untitled Task';
                const due = task.endTime || task.end_time || task.dueDate || task.deadline || 'Time Not Specified';
                const taskType = task.maxContent ? `Max Content: ${task.maxContent}` : (task.fcfs ? 'FCFS' : 'Open Task');

                reportMessage += `📌 <b>Title:</b> ${escapeHTML(taskTitle)}\n`;
                reportMessage += `🆔 <b>ID:</b> <code>${task.id || 'N/A'}</code>\n`;
                reportMessage += `⏳ <b>Ends:</b> ${escapeHTML(due)}\n`;
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

// 6. Long Polling Command Listener (with Unauthorized Chat ID diagnostics)
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
                        // Diagnostic log: helps you find your Chat ID if it isn't in .env yet
                        console.log(`[Diagnostic] Unauthorized Chat ID tried talking to bot. Chat ID: "${chatId}" | Text: "${update.message.text}"`);
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