require('dotenv').config();
const express = require('express');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_IDS = process.env.CHAT_ID ? process.env.CHAT_ID.split(',').map(id => id.trim()) : [];
const PORT = process.env.PORT || 3000;

// ADD YOUR SESSION COOKIE OR AUTH TOKEN HERE IF NEEDED
const SESSION_COOKIE = process.env.SESSION_COOKIE || ''; 

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

const app = express();
app.get('/', (req, res) => res.send('BuildersWatcherBot is online.'));
app.listen(PORT, () => console.log(`Health check server listening on port ${PORT}`));

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
            const errData = await response.json();
            console.error(`Telegram API Error:`, errData);
        }
    } catch (err) {
        console.error(`Failed to send message to ${chatId}:`, err.message);
    }
}

// Updated fetchCampaigns with Diagnostic logs
async function fetchCampaigns() {
    const headers = {
        "accept": "application/json, text/plain, */*",
        "accept-language": "en-US,en;q=0.9",
        "Referer": "https://www.bitgetbuilder.com/"
    };

    // Attach cookie if you retrieved it from your browser DevTools
    if (SESSION_COOKIE) {
        headers["cookie"] = SESSION_COOKIE;
    }

    const response = await fetch("https://api.bitgetbuilder.com/server/campaigns", {
        "headers": headers,
        "method": "GET"
    });
    
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    const data = await response.json();
    
    let allTasks = Array.isArray(data.campaigns) ? data.campaigns : (Array.isArray(data) ? data : []);
    
    // DIAGNOSTIC LOG 1: Check if API returned any tasks at all
    console.log(`[Diagnostic] Raw API Campaign Count: ${allTasks.length}`);
    if (allTasks.length > 0) {
        console.log(`[Diagnostic] First Task Raw Sample:`, JSON.stringify(allTasks[0]));
    } else {
        console.log(`[Diagnostic] API returned 0 tasks. You must grab your Cookie/Auth header from your browser DevTools and add it to your request headers.`);
    }

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
            if (!isNaN(endMs) && endMs < Date.now()) {
                console.log(`[Diagnostic] Task ${taskId} filtered out: Ended (Time past)`);
                return false; 
            }
        }

        // RULE 2: Status Check
        const statusStr = String(task.status || task.state || task.taskStatus || '').toLowerCase();
        if (statusStr === 'ended' || statusStr === 'completed') {
            console.log(`[Diagnostic] Task ${taskId} filtered out: Status is ${statusStr}`);
            return false;
        }

        // RULE 3: THE EXPLICIT BLACKLIST
        const titleStr = String(task.title || task.name || '').toLowerCase();
        const teamStr = String(task.team || task.taskCategory || '').toLowerCase().trim();

        // FIX: Replaced broad JSON string search with target field searches to avoid false positives
        if (titleStr.includes('(cmc)') || 
            titleStr.includes('winner') || 
            titleStr.includes('reddit') || 
            teamStr.includes('target') || 
            teamStr.includes('private')) {
            console.log(`[Diagnostic] Task ${taskId} filtered out: Hit explicit blacklist`);
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
            console.log(`[Diagnostic] Task ${taskId} filtered out: Not in whitelist categories (Team: ${teamStr})`);
            return false; 
        }

        console.log(`[Diagnostic] Task ${taskId} (${titleStr}) PASSED all filters.`);
        return true; 
    });
}

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

async function handleCommand(chatId, text) {
    const cleanText = text.trim().toLowerCase();

    if (cleanText === '/start') {
        const startMenu = `⚡ <b>BuildersWatcherBot</b> ⚡\n\n` +
                          `I am built for scanning for new tasks on the <a href="https://www.bitgetbuilder.com/">Bitget Builder Hub</a> to give immediate notice to connected builders.\n\n` +
                          `⚙️ <b>System Settings:</b>\n` +
                          `⏱️ <b>Auto Scan:</b> Every 1 minute\n` +
                          `🧹 <b>Data Filter:</b> Active (Ended & private tasks removed, open tasks only)\n\n` +
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
                await sendMessage(chatId, `⏸️ <b>Status:</b> Radar is clear. No active tasks available.`);
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
                        console.log(`[Diagnostic] Unauthorized Chat ID tried talking to bot: "${chatId}"`);
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