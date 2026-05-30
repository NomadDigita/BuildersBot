require('dotenv').config();
const fetch = require('node-fetch'); // Restored to prevent "fetch is not defined" crashes
const express = require('express');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_IDS = process.env.CHAT_ID ? process.env.CHAT_ID.split(',').map(id => id.trim()) : [];
const PORT = process.env.PORT || 3000;

// Configurable Task Filter: 'automatic', 'manual', or 'both'
const TASK_CHECK_TYPE = (process.env.TASK_CHECK_TYPE || 'both').toLowerCase().trim();

// Setup headers for login session (Render environment variables)
const SESSION_COOKIE = process.env.SESSION_COOKIE || '';
const AUTHORIZATION_HEADER = process.env.AUTHORIZATION || '';

if (!TELEGRAM_TOKEN) {
    console.error("CRITICAL ERROR: TELEGRAM_TOKEN is missing from your .env file.");
    process.exit(1);
}

const CHECK_INTERVAL = 1 * 60 * 1000; 

let offset = 0;
let seenTasks = new Set(); 
let isFirstBoot = true;    

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

// UID Checker
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
            if (Array.isArray(val) && val.length > 0) return true;
            if (typeof val === 'string' && val.trim().length > 0 && /\d+/.test(val)) return true;
            if (typeof val === 'number') return true;
        }
    }

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

// Check Type Matcher
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

// Filter engine
async function fetchCampaigns() {
    const allTasks = await fetchRawCampaigns();
    
    // Sort descending
    allTasks.sort((a, b) => {
        const idA = parseInt(String(a.id).replace(/\D/g, '')) || 0;
        const idB = parseInt(String(b.id).replace(/\D/g, '')) || 0;
        return idB - idA;
    });

    return allTasks.filter(task => {
        const dueStr = task.endTime || task.end_time || task.dueDate || task.deadline || task.due;
        if (dueStr) {
            const cleanDateStr = String(dueStr).replace(/\(GMT[+-]\d+\)/i, '').trim();
            const endMs = new Date(cleanDateStr).getTime();
            if (!isNaN(endMs) && endMs < Date.now()) return false; 
        }

        const statusStr = String(task.status || task.state || task.taskStatus || '').toLowerCase();
        if (statusStr === 'ended' || statusStr === 'completed') return false;

        const titleStr = String(task.title || task.name || '').toLowerCase();
        const teamStr = String(task.team || task.taskCategory || '').toLowerCase().trim();

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

// Live In-Chat Diagnostic Generator
async function getTaskFilteringReport() {
    try {
        const allTasks = await fetchRawCampaigns();
        
        if (allTasks.length === 0) {
            return `⚠️ <b>API returned 0 tasks.</b>\n\n` +
                   `This means the API rejected Render's request because you are not logged in.\n\n` +
                   `💡 <b>How to Fix:</b>\n` +
                   `1. Log in to the site on your computer browser.\n` +
                   `2. Open Inspect -> Network -> select the <code>campaigns</code> request.\n` +
                   `3. Copy the <code>Cookie</code> or <code>Authorization</code> header.\n` +
                   `4. Go to Render Dashboard -> Environment -> Add <code>SESSION_COOKIE</code> or <code>AUTHORIZATION</code> variable.`;
        }

        let report = `📊 <b>Diagnostic Filter Report</b>\n`;
        report += `Total Raw Tasks Fetched: <b>${allTasks.length}</b>\n\n`;

        // Audit the top 5 tasks to see why they passed or failed
        const sampleTasks = allTasks.slice(0, 5);
        for (const task of sampleTasks) {
            const taskId = task.id || 'N/A';
            const title = task.title || task.name || 'Untitled';
            let status = "✅ PASSED";
            let reason = "";

            // 1. Time
            const dueStr = task.endTime || task.end_time || task.dueDate || task.deadline || task.due;
            if (dueStr) {
                const cleanDateStr = String(dueStr).replace(/\(GMT[+-]\d+\)/i, '').trim();
                const endMs = new Date(cleanDateStr).getTime();
                if (!isNaN(endMs) && endMs < Date.now()) {
                    status = "❌ SKIPPED";
                    reason = `Time expired`;
                }
            }

            // 2. Status Check
            if (status === "✅ PASSED") {
                const statusStr = String(task.status || task.state || task.taskStatus || '').toLowerCase();
                if (statusStr === 'ended' || statusStr === 'completed') {
                    status = "❌ SKIPPED";
                    reason = `Status is "${statusStr}"`;
                }
            }

            // 3. Blacklist Check
            if (status === "✅ PASSED") {
                const titleStr = String(task.title || task.name || '').toLowerCase();
                const teamStr = String(task.team || task.taskCategory || '').toLowerCase().trim();
                if (titleStr.includes('(cmc)') || titleStr.includes('winner') || titleStr.includes('reddit') || teamStr.includes('target') || teamStr.includes('private')) {
                    status = "❌ SKIPPED";
                    reason = `Hit word blacklist`;
                }
            }

            // 4. Group check
            const teamStr = String(task.team || task.taskCategory || '').toLowerCase().trim();
            if (status === "✅ PASSED") {
                const isTargetedGroup = teamStr === '' || teamStr === 'none' || teamStr === 'null' || teamStr.includes('core') || teamStr.includes('trainee') || teamStr.includes('vip') || teamStr.includes('everyone') || teamStr.includes('open');
                if (!isTargetedGroup) {
                    status = "❌ SKIPPED";
                    reason = `Not whitelisted role (Team: "${teamStr}")`;
                }
            }

            // 5. Specific UIDs check
            if (status === "✅ PASSED" && hasSpecificUIDs(task)) {
                status = "❌ SKIPPED";
                reason = `UID restriction / whitelist detected`;
            }

            // 6. Check Type Match
            if (status === "✅ PASSED" && !matchesTaskCheckType(task)) {
                status = "❌ SKIPPED";
                reason = `Check type mismatches filter`;
            }

            report += `🔹 <b>[ID: ${taskId}]</b> ${escapeHTML(title.substring(0, 30))}...\n`;
            report += `Result: ${status} ${reason ? `(${reason})` : ''}\n\n`;
        }

        if (allTasks[0]) {
            report += `🔑 <b>First Task JSON Keys:</b>\n<code>${Object.keys(allTasks[0]).join(', ')}</code>\n`;
        }

        return report;
    } catch (err) {
        return `❌ <b>Diagnostic Error:</b> ${escapeHTML(err.message)}`;
    }
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

// 5. Command Terminal
async function handleCommand(chatId, text) {
    const cleanText = text.trim().toLowerCase();

    if (cleanText === '/start') {
        const startMenu = `⚡ <b>BuildersWatcherBot</b> ⚡\n\n` +
                          `⚙️ <b>System Settings:</b>\n` +
                          `⏱️ <b>Auto Scan:</b> Every 1 minute\n` +
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