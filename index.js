require('dotenv').config();
const express = require('express');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_IDS = process.env.CHAT_ID ? process.env.CHAT_ID.split(',').map(id => id.trim()) : [];
const PORT = process.env.PORT || 3000;

// Configurable Task Filter: 'automatic', 'manual', or 'both'
const TASK_CHECK_TYPE = (process.env.TASK_CHECK_TYPE || 'both').toLowerCase().trim();

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

// Helper to determine if a task is limited to specific UIDs
function hasSpecificUIDs(task) {
    const uidKeys = [
        'uid', 'uids', 'uidlist', 'uid_list', 'targetuids', 'target_uids',
        'whitelist', 'white_list', 'assigneduids', 'assigned_uids', 
        'userids', 'user_ids', 'memberlist', 'member_list', 'specified_uids',
        'specifieduids', 'assignuids', 'assign_uids', 'specified'
    ];

    for (const key of Object.keys(task)) {
        const lowerKey = key.toLowerCase();
        
        if (uidKeys.some(uKey => lowerKey.includes(uKey))) {
            const val = task[key];
            
            // Discard if it contains a structured list of target UIDs
            if (Array.isArray(val) && val.length > 0) {
                return true;
            }
            
            // Discard if it's a non-empty string with specific UID numbers
            if (typeof val === 'string' && val.trim().length > 0) {
                if (/\d+/.test(val)) return true;
            }
            
            // Discard if it represents an individual target ID assignment
            if (typeof val === 'number') {
                return true;
            }
        }
    }

    // Secondary deep text description checks
    const titleStr = String(task.title || '').toLowerCase();
    const descStr = String(task.description || task.content || '').toLowerCase();
    
    if (descStr.includes('specific uid') || 
        descStr.includes('whitelist only') || 
        descStr.includes('target uid') || 
        descStr.includes('selected uid') || 
        descStr.includes('only for uids')) {
        return true;
    }

    return false;
}

// Helper to check if task matches configured check type (automatic, manual, or both)
function matchesTaskCheckType(task) {
    if (TASK_CHECK_TYPE === 'both') return true;

    const isAutoCheck = task.isAuto === true || 
                        task.auto === true || 
                        task.autoCheck === true || 
                        String(task.checkType || task.type || task.auditType || '').toLowerCase().includes('auto');

    if (TASK_CHECK_TYPE === 'automatic') return isAutoCheck;
    if (TASK_CHECK_TYPE === 'manual') return !isAutoCheck;

    return true;
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
    
    // Sort by ID descending
    allTasks.sort((a, b) => {
        const idA = parseInt(String(a.id).replace(/\D/g, '')) || 0;
        const idB = parseInt(String(b.id).replace(/\D/g, '')) || 0;
        return idB - idA;
    });

    return allTasks.filter(task => {
        const taskId = task.id || 'Unknown';

        // RULE 1: Time Check
        const dueStr = task.endTime || task.end_time || task.dueDate || task.deadline || task.due;
        if (dueStr) {
            const cleanDateStr = String(dueStr).replace(/\(GMT[+-]\d+\)/i, '').trim();
            const endMs = new Date(cleanDateStr).getTime();
            if (!isNaN(endMs) && endMs < Date.now()) return false; 
        }

        // RULE 2: Status Check
        const statusStr = String(task.status || task.state || task.taskStatus || '').toLowerCase();
        if (statusStr === 'ended' || statusStr === 'completed') return false;

        // RULE 3: Exclude targeted or private titles
        const titleStr = String(task.title || task.name || '').toLowerCase();
        const teamStr = String(task.team || task.taskCategory || '').toLowerCase().trim();

        if (titleStr.includes('(cmc)') || 
            titleStr.includes('winner') || 
            titleStr.includes('reddit') || 
            teamStr.includes('target') || 
            teamStr.includes('private')) {
            return false; 
        }

        // RULE 4: Strict Core Builder, Trainee & VIP Role Whitelist
        const isTargetedGroup = teamStr === '' || 
                               teamStr === 'none' || 
                               teamStr === 'null' || 
                               teamStr.includes('core') || 
                               teamStr.includes('trainee') || 
                               teamStr.includes('vip') || 
                               teamStr.includes('everyone') || 
                               teamStr.includes('open');

        if (!isTargetedGroup) return false; 

        // RULE 5: EXCLUDE tasks containing Specific whitelists / target UIDs
        if (hasSpecificUIDs(task)) {
            console.log(`[Diagnostic] Skipped Task ${taskId} -> Contains Specific UID restrictions.`);
            return false;
        }

        // RULE 6: Automatic vs Manual Type Matcher
        if (!matchesTaskCheckType(task)) {
            console.log(`[Diagnostic] Skipped Task ${taskId} -> Does not match TASK_CHECK_TYPE (${TASK_CHECK_TYPE}).`);
            return false;
        }

        console.log(`[Diagnostic] Task ${taskId} (${task.title || 'Untitled'}) matches filters!`);
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
                          `🧹 <b>Filter Mode:</b> Active (Role: Core/Trainee/VIP, Type: ${TASK_CHECK_TYPE.toUpperCase()}, Whitelisted UIDs: Excluded)\n\n` +
                          `🛠️ <b>Commands:</b>\n` +
                          `🔹 /start - View this setup menu.\n` +
                          `🔹 /scan - Force an immediate manual check for live tasks.`;
                            
        await sendMessage(chatId, startMenu);
    } 
    
    else if (cleanText === '/scan') {
        await sendMessage(chatId, `🔍 <b>Scanning for ONGOING tasks only...</b>`);
        try {
            const activeTasks = await fetchCampaigns();
            
            if (activeTasks.length === 0) {
                await sendMessage(chatId, `⏸️ <b>Status:</b> Radar is clear. No active open tasks match.`);
                return;
            }

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
                    if (CHAT_IDS.includes(chatId)) {
                        await handleCommand(chatId, update.message.text);
                    } else {
                        console.log(`[Diagnostic] Unauthorized Chat ID ignored: "${chatId}"`);
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