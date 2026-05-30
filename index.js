require('dotenv').config();
const fetch = require('node-fetch'); // Standardized fetch import
const express = require('express');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_IDS = process.env.CHAT_ID ? process.env.CHAT_ID.split(',').map(id => id.trim()) : [];
const PORT = process.env.PORT || 3000;

// Configurable Task Filter: 'automatic', 'manual', or 'both'
const TASK_CHECK_TYPE = (process.env.TASK_CHECK_TYPE || 'both').toLowerCase().trim();

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

// Robust date parser for (GMT+8) formats
function parseTaskDate(dateStr) {
    if (!dateStr) return 0;
    const cleanStr = String(dateStr).replace(/\(GMT[+-]\d+\)/i, '').trim();
    const parsed = Date.parse(cleanStr);
    return isNaN(parsed) ? 0 : parsed;
}

// Initialize Render Health Check Server
const app = express();
app.get('/', (req, res) => res.send('BuildersWatcherBot is online.'));
app.listen(PORT, () => console.log(`Health check server listening on port ${PORT}`));

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

// Strict UID Checker matching the API schema
function hasSpecificUIDs(task) {
    // 1. If automatic UIDs are assigned
    const autoUids = task.autoSelectedUIDs;
    if (autoUids) {
        if (Array.isArray(autoUids) && autoUids.length > 0) return true;
        if (typeof autoUids === 'string' && autoUids.trim().length > 0) return true;
    }
    
    // 2. If manual UIDs are assigned
    const manualUids = task.manualSelectedUIDs;
    if (manualUids) {
        if (Array.isArray(manualUids) && manualUids.length > 0) return true;
        if (typeof manualUids === 'string' && manualUids.trim().length > 0) return true;
    }

    // 3. If manual selected boolean is flagged
    if (task.manualSelected === true) return true;

    return false;
}

// Check Type Matcher (Automatic vs Manual verification check)
function matchesTaskCheckType(task) {
    if (TASK_CHECK_TYPE === 'both') return true;

    // Evaluate auto properties
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

// Cleaned and fully targeted Filter Engine
async function fetchCampaigns() {
    const allTasks = await fetchRawCampaigns();
    
    // SORT BY DEADLINE DESCENDING (Future/active deadlines will be at the very top of the list)
    allTasks.sort((a, b) => {
        const timeA = parseTaskDate(a.deadline);
        const timeB = parseTaskDate(b.deadline);
        return timeB - timeA;
    });

    return allTasks.filter(task => {
        // 1. Time Check (Ongoing check)
        const dueStr = task.deadline;
        if (dueStr) {
            const endMs = parseTaskDate(dueStr);
            if (endMs !== 0 && endMs < Date.now()) return false; 
        }

        // 2. Blacklist / Name filter
        const titleStr = String(task.title || '').toLowerCase();
        const categoryStr = String(task.taskCategory || '').toLowerCase();
        const teamStr = String(task.targetTeam || task.targetLabel || '').toLowerCase();

        if (titleStr.includes('(cmc)') || 
            titleStr.includes('winner') || 
            titleStr.includes('reddit') || 
            teamStr.includes('target') || 
            teamStr.includes('private')) {
            return false; 
        }

        // 3. Strict Whitelist (Core, Trainee, VIP roles only)
        const isTargetedGroup = teamStr === '' || 
                               teamStr === 'none' || 
                               teamStr === 'null' || 
                               teamStr.includes('core') || 
                               teamStr.includes('trainee') || 
                               teamStr.includes('vip') || 
                               teamStr.includes('everyone') || 
                               teamStr.includes('open');

        if (!isTargetedGroup) return false; 

        // 4. Reject any targeted user restriction (Specific UIDs)
        if (hasSpecificUIDs(task)) return false;

        // 5. Automatic vs Manual task toggle
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

        // Sort descending
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

// Autonomous 1-Minute Scanner
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

// Command Terminal
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
                const taskTitle = task.title || 'Untitled Task';
                const due = task.deadline || 'Time Not Specified';
                const taskType = task.maxContent ? `Max Content: ${task.maxContent}` : 'Open Task';

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

// Long Polling Command Listener
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