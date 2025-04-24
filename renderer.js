const { ipcRenderer, app, ipcMain, net } = require('electron');
const { loadGameplayConfigData, saveGameplayConfigData } = require('./exports/gameplayConfigHandler');
const { loadRAConfigData, saveRAConfigData, addRole, addMember } = require('./exports/RAConfigHander');
const path = require('path');
const os = require('os');
const { start } = require('repl');
const fs = require('fs');

// Variables to track uptime
let uptimeInterval;
let startTime = null;

let activePlayers = {};

let maxPlayers = null;
let gameVersion = null;

const themes = {
    dark: {
        '--primary': '#7289da',
        '--primary-dark': '#5b6eae',
        '--secondary': '#43b581',
        '--danger': '#f04747',
        '--warning': '#faa61a',
        '--background': '#36393f',
        '--background-dark': '#2f3136',
        '--background-light': '#40444b',
        '--text': '#dcddde',
        '--text-muted': '#72767d',
        '--border': '#202225',
        '--success': '#43b581',
    },
    light: {
        '--primary': '#5865F2',
        '--primary-dark': '#404ec2',
        '--secondary': '#57F287',
        '--danger': '#ED4245',
        '--warning': '#FEE75C',
        '--background': '#ffffff',
        '--background-dark': '#f2f3f5',
        '--background-light': '#e3e5e8',
        '--text': '#2e3338',
        '--text-muted': '#72767d',
        '--border': '#d1d1d1',
        '--success': '#57F287',
    }
};

function applyTheme(themeName) {
    const theme = themes[themeName];
    if (!theme) return;
    for (const key in theme) {
        document.documentElement.style.setProperty(key, theme[key]);
    }
}

// Get the config file path using the home directory
const gameplayConfigFilePath = path.join(
    os.homedir(),
    'AppData',
    'Roaming',
    'SCP Secret Laboratory',
    'config',
    '7777',
    'config_gameplay.txt'
);

// Get the config file path using the home directory
const remoteAdminConfigFilePath = path.join(
    os.homedir(),
    'AppData',
    'Roaming',
    'SCP Secret Laboratory',
    'config',
    '7777',
    'config_remoteadmin.txt'
);

function processLogEntry(log) {
    // Regular expressions to match the two types of strings
    const preauthRegex = /\[.*\] Player (\d+)@steam preauthenticated from endpoint ([\d\.]+:\d+)\./;
    const nicknameRegex = /\[.*\] Nickname of (\d+)@steam is now (.+)\./;
    const disconnectRegex = /\[.*\] (.+) \((\d+)@steam\) disconnected from IP address ([\d\.]+)\./;

    // Check if the log matches the preauthentication string
    let preauthMatch = log.match(preauthRegex);
    if (preauthMatch) {
        const steamId = preauthMatch[1];
        const ip = preauthMatch[2];

        // Update the activePlayers table with IP
        if (!activePlayers[steamId]) {
            activePlayers[steamId] = { ip: "", username: "" };
        }
        activePlayers[steamId].ip = ip;
        console.log(`Updated IP for player ${steamId}: ${ip}`);
        return;
    }

    // Check if the log matches the nickname change string
    let nicknameMatch = log.match(nicknameRegex);
    if (nicknameMatch) {
        const steamId = nicknameMatch[1];
        const username = nicknameMatch[2];

        // Update the activePlayers table with username
        if (!activePlayers[steamId]) {
            activePlayers[steamId] = { ip: "", username: "" };
        }
        activePlayers[steamId].username = username;
        console.log(`Updated username for player ${steamId}: ${username}`);
        return;
    }

    // Check if the log matches the disconnect string
    let disconnectMatch = log.match(disconnectRegex);
    if (disconnectMatch) {
        const username = disconnectMatch[1];
        const steamId = disconnectMatch[2];
        
        // Remove the player from the activePlayers table
        if (activePlayers[steamId]) {
            delete activePlayers[steamId];
            console.log(`Removed player ${username} with Steam ID ${steamId} from active players.`);
        }
        return;
    }

    console.log("No match found for the log entry.");
}

function loadLogs(logsDir) {
    const container = document.getElementById('logsContainer');
    const preview = document.getElementById('previewContent');
    container.innerHTML = '';

    fs.readdir(logsDir, (err, files) => {
        if (err) {
            console.error('Failed to read log directory:', err);
            return;
        }

        const logFiles = files.filter(file => file.endsWith('.txt'));

        logFiles.forEach(file => {
            const filePath = path.join(logsDir, file);
            const stats = fs.statSync(filePath);
            const sizeInMB = (stats.size / (1024 * 1024)).toFixed(1);
            let formattedDate = 'Unknown';
            const dateTimeMatch = file.match(/log-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-\d{3}Z/);

            if (dateTimeMatch) {
                const [, date, hour, minute, second] = dateTimeMatch;
                formattedDate = `${date} ${hour}:${minute}:${second}`;
            }

            const logItem = document.createElement('div');
            logItem.className = 'log-item';
            logItem.innerHTML = `
                <div class="log-info">
                    <span class="log-date">${formattedDate}</span>
                    <span class="log-name">${file}</span>
                    <span class="log-size">${sizeInMB} MB</span>
                </div>
                <div class="log-actions">
                    <button class="log-view">View</button>
                    <button class="log-download">Download</button>
                    <button class="log-delete">Delete</button>
                </div>
            `;

            const viewBtn = logItem.querySelector('.log-view');
            const downloadBtn = logItem.querySelector('.log-download');
            const deleteBtn = logItem.querySelector('.log-delete');

            viewBtn.addEventListener('click', () => {
                fs.readFile(filePath, 'utf-8', (err, data) => {
                    if (err) {
                        preview.innerHTML = `<pre>Error reading log</pre>`;
                    } else {
                        preview.innerHTML = `<pre>${data}</pre>`;
                    }
                });
            });

            downloadBtn.addEventListener('click', () => {
                ipcRenderer.send('download-log', { name: file, path: filePath });
            });

            deleteBtn.addEventListener('click', () => {
                fs.unlink(filePath, err => {
                    if (err) {
                        alert('Failed to delete log');
                    } else {
                        loadLogs(logsDir); // reload
                    }
                });
            });

            container.appendChild(logItem);
        });
    });
}

function refreshServerDir(serverDir) {
    const dirText = document.getElementById("server-dir");
    dirText.setAttribute("value", serverDir);
}

document.addEventListener('DOMContentLoaded', async () => {
    const startButton = document.getElementById('start-server');
    const stopButton = document.getElementById('stop-server');
    const logBox = document.getElementById('console-text');
    const userInput = document.getElementById('userInput');
    const submitInput = document.getElementById('submitInput');
    const uptimeText = document.getElementById('uptime');
    const refreshPlayersButton = document.getElementById('refresh-players');
    const refreshIcon = document.getElementById('refreshIcon');
    const playersList = document.getElementById('active-players-list');
    const externalIp = document.getElementById('external-ipv4');
    const saveGameplayConfigButton = document.getElementById('save-gameplay-config')
    const saveRaConfigButton = document.getElementById('save-ra-config')
    const addRoleButton = document.getElementById('add-role-btn')
    const addMemberButton = document.getElementById('add-member-btn')
    const consoleSearch = document.getElementById('consoleSearch');
    const searchButton = document.getElementById('submitSearch');
    const saveLogsButton = document.getElementById('save-logs');
    const copyLocalButton = document.getElementById('copy-local');
    const copyExternalButton = document.getElementById('copy-external');
    const changeDirectoryButton = document.getElementById('change-directory');
    const reloadLogsButton = document.getElementById('refreshLogs')
    const themeSelect = document.getElementById('theme')

    if(themeSelect){
        themeSelect.addEventListener('change', (e) => {
            const selectedTheme = e.target.value;
            ipcRenderer.send('set-theme', selectedTheme);
            applyTheme(selectedTheme);
        });
    }

    ipcRenderer.invoke('get-theme').then((theme) => {
        themeSelect.value = theme;
        applyTheme(theme);
    });

    if(reloadLogsButton){
        reloadLogsButton.addEventListener('click', () => {
            ipcRenderer.invoke('get-logs-dir').then(loadLogs);
        })
    }

    ipcRenderer.invoke('get-logs-dir').then(loadLogs);
    ipcRenderer.invoke('get-server-dir').then(refreshServerDir);

    if(changeDirectoryButton){
        changeDirectoryButton.addEventListener('click', () => {
            ipcRenderer.send('change-directory');
        })
    }

    const allLogs = [];
    if(saveLogsButton){
        saveLogsButton.addEventListener('click', () => {
            const logContent = allLogs.map(entry => `[${entry.timestamp}] ${entry.log}`).join('\n');
            ipcRenderer.send('save-console-logs', logContent);
        }); 
    }   

    function displayLogs(logs) {
        logBox.innerHTML = '';
        logs.forEach(entry => {
            const formattedLog = formatLog(entry);
            logBox.innerHTML += formattedLog;
        });
        document.getElementById("console-output").scrollTop = document.getElementById("console-output").scrollHeight;
    }
    
    if(addRoleButton && addMemberButton){
        addRoleButton.addEventListener('click', addRole);
        addMemberButton.addEventListener('click', addMember);
    }

    // Function to format and update the uptime display
    function updateUptimeDisplay() {
        if (startTime) {
            const elapsedSeconds = Math.floor((Date.now() - startTime) / 1000);
            const formattedUptime = formatUptime(elapsedSeconds); // Assuming you have a formatUptime function
            uptimeText.textContent = formattedUptime;
        }
    }

    // Function to format uptime from seconds
    function formatUptime(seconds) {
        const hours = Math.floor(seconds / 3600);
        seconds %= 3600;
        const minutes = Math.floor(seconds / 60);
        seconds = Math.floor(seconds % 60);
        return `${hours}h ${minutes}m ${seconds}s`;
    }

    function updateServerStatus(status) {
        const statusDot = document.getElementById('status-bar');
        const statusIndicator = document.getElementById('status-indicator')

        if(!statusbar || !statusDot){
            return;
        }
        
        switch (status) {
            case 'offline':
                submitInput.disabled = true;
                userInput.disabled = true;
                statusDot.innerHTML = `Offline`;
                statusIndicator.style.backgroundColor = 'rgb(255, 70, 70)';
                break;
            case 'starting':
                statusDot.innerHTML = `Starting`;
                statusIndicator.style.backgroundColor = 'rgb(255, 196, 70)';
                break;
            case 'online':
                statusDot.innerHTML = `Online`;
                statusIndicator.style.backgroundColor = 'rgb(70, 255, 70)';
                // submitInput.disabled = false;
                // userInput.disabled = false;
                break;
            case 'idle':
                statusDot.innerHTML = `Idle`;
                statusIndicator.style.backgroundColor = 'rgb(70, 70, 70)';
                break;
            default:
                statusDot.innerHTML = `Offline`;
                statusIndicator.style.backgroundColor = 'rgb(255, 70, 70)';
        }
    }
    
    updateServerStatus("offline")

    // Call the function to populate the table when the page loads or when necessary
    loadRAConfigData(remoteAdminConfigFilePath);
    loadGameplayConfigData(gameplayConfigFilePath);

    fs.readFile(gameplayConfigFilePath, 'utf-8', (err, data) => {
        if (err) {
            console.error("Error reading config file:", err);
            return;
        }
    
        const lines = data.split('\n');
    
        for (const rawLine of lines) {
            const line = rawLine.trim();
    
            if (!line || line.startsWith('#')) {
                console.log("Ignoring line:", line); // Log ignored lines
                continue; // Ignore empty lines and comments
            }
    
            const [key, value] = line.split(':');
            if (key && value && key.trim() === "max_players") {
                maxPlayers = value.trim();
                break; // ✅ Stop reading once max_players is found
            }
        }
    });    

    if (saveGameplayConfigButton) {
        saveGameplayConfigButton.addEventListener('click', (event) => {
            event.preventDefault();
            const configData = {};
    
            document.querySelectorAll('#gameplay-config-body .form-group').forEach(group => {
                const label = group.querySelector('label');
                const input = group.querySelector('input');
                if (label && input) {
                    configData[label.textContent] = input.value;
                }
            });
            
            console.log(configData);
            saveGameplayConfigData(configData, gameplayConfigFilePath);
        });
    }    

    // Add this section after your saveGameplayConfigButton listener
    if(saveRaConfigButton){
        saveRaConfigButton.addEventListener('click', (event) => {
            event.preventDefault();
            const raConfigData = {};
    
            // Loop through each input related to RA config and populate raConfigData
            document.querySelectorAll('.ra-config-input').forEach(input => {
                const field = input.querySelector("label");
                raConfigData[field] = input.value;
            });
    
            // Call saveRAConfigData with the data and file path
            saveRAConfigData(raConfigData, remoteAdminConfigFilePath); // Save the updated data to the RA config file
        });
    }

    function getExternalIP() {
        return ipcRenderer.invoke('get-external-ip')
            .then(ip => {
                console.log(`External IP: ${ip}`);
                return ip; // Optionally return the IP
            })
            .catch(err => {
                console.error(err);
                return null; // Handle the error as needed
            });
    }

    const ip = await getExternalIP();
    if(externalIp){
        externalIp.innerHTML = `${ip}:7777`;
    }

    if(copyLocalButton){
        copyLocalButton.addEventListener('click', () => {
            var copyText = '127.0.0.1:7777';
            navigator.clipboard.writeText(copyText);
            alert('Copied Local IP');
        })
    }

    if(copyExternalButton){
        copyExternalButton.addEventListener('click', () => {
            var copyText = `${ip}:7777`;
            navigator.clipboard.writeText(copyText);
            alert('Copied External IP');
        })
    }

    /**
     * Formats log messages with custom colors for timestamps, tags, and main text.
     * @param {string} log - The log message to format.
     * @returns {string} - The HTML-formatted string with colors.
    */
    function formatLog(entry) {
        const { timestamp, log } = entry;
        console.log('Raw log data:', log);
        const currentYear = new Date().getFullYear(); // Get the current year
    
        const lines = log.split('\n'); // Split log into lines
    
        const formattedLines = lines.map(line => {
            const formattedLine = line.replace(/(\[.*?\])|([^[]+)/g, (match, bracketedText, plainText) => {
                if (bracketedText) {
                    const text = bracketedText;
                    if (text.includes(currentYear)) {
                        return `<span class="timestamp">${text}</span>`;
                    } else {
                        return `<span class="tag">${text}</span>`;
                    }
                } else if (plainText) {
                    if (plainText.includes('Port') && plainText.includes('UPnP')) {
                        return `<span class="port">${plainText}</span>`;
                    } else if (plainText.includes('Could not update data on server list')) {
                        return `<span class="error">${plainText}</span>`;
                    } else {
                        return `<span class="default">${plainText}</span>`;
                    }
                }
            });
    
            // Prepend our custom timestamp in a dark font
            return `${formattedLine}`;
        });
    
        return formattedLines.join('');
    }

    if (startButton && stopButton && logBox && userInput && submitInput) {
        console.log("EXISTS")
        startButton.addEventListener('click', () => {
            startButton.disabled = true;
            stopButton.disabled = false;
            ipcRenderer.send('start-server'); // Send the port to main.js
        });

        stopButton.addEventListener('click', () => {
            startButton.disabled = false;
            stopButton.disabled = true;
            ipcRenderer.send('stop-server');
        });

        submitInput.addEventListener('click', () => {
            const userInputValue = userInput.value.trim();
            if(userInputValue !== "" && userInputValue){
                ipcRenderer.send('send-input', userInputValue);
            }
        })

        // searchButton.addEventListener('click', () => {
        //     const query = consoleSearch.value.toLowerCase().trim();
        
        //     if (!query) {
        //         displayLogs(allLogs);
        //     } else {
        //         const filteredLogs = allLogs.filter(entry => entry.log.toLowerCase().includes(query));
        //         displayLogs(filteredLogs);
        //     }
        // });        

        // Function to update the player table in the DOM
        async function updatePlayerTable() {
            const tbody = document.getElementById('trbody'); // Get the tbody for adding rows
            try {
                console.log(activePlayers);
                
                // Clear current list while keeping the header row
                while (tbody.rows.length > 0) {
                    tbody.innerHTML = "";
                }

                // Populate table with active players
                for (const steamId in activePlayers) {
                    const player = activePlayers[steamId];
                    const row = document.createElement('tr');
                    row.innerHTML = `
                        <td>${player.username || 'Unknown'}</td>
                        <td>${steamId || 'Unknown'}</td>
                        <td>${player.ip || 'Unknown'}</td>
                    `;
                    tbody.appendChild(row); // Append the new row to the tbody
                }

                const currentPlayers = Object.keys(activePlayers).length
                const playerNumText = document.getElementById('currentPlayers');
                playerNumText.textContent = currentPlayers + "/" + maxPlayers
            } catch (error) {
                // Populate table with active players
                for (const steamId in activePlayers) {
                    const player = activePlayers[steamId];
                    const row = document.createElement('tr');
                    row.innerHTML = `
                        <td>${player.username || 'Unknown'}</td>
                        <td>${steamId || 'Unknown'}</td>
                        <td>${player.ipAddress || 'Unknown'}</td>
                    `;
                    tbody.appendChild(row); // Append the new row to the tbody
                }
            }
        }

        setInterval(function() {
            updatePlayerTable();
        }, 2000);

        if(refreshPlayersButton){
            refreshPlayersButton.addEventListener('click', () => {
                refreshIcon.classList.add('spin');
                updatePlayerTable();
    
                setTimeout(() => {
                    refreshIcon.classList.remove('spin');
                }, 300);
            })
        }

        ipcRenderer.on('log-saved', (event, log) => {
            alert(log);
        })

        // Display server logs in real-time in the log box
        ipcRenderer.on('server-log', (event, log) => {
            const timestamp = getFormattedTimestamp();
            const entry = { timestamp, log }; // Store as object
            allLogs.push(entry);
            displayLogs(allLogs);

            processLogEntry(log);

            // Enable input when server requests a port number
            if (log.includes('Port number (default: 7777):')) {
                updateServerStatus("starting");
                ipcRenderer.send('send-input', "7777");
            } else if(log.includes('Received first heartbeat')) {
                updateServerStatus("online");
                if (!startTime) {
                    startTime = Date.now(); // Set the start time for uptime
                    uptimeInterval = setInterval(updateUptimeDisplay, 1000); // Update every second
                }
            } else if(log.includes('entered') && log.includes('idle mode')) {
                updateServerStatus("idle");
            } else if(log.includes('exited') && log.includes('idle mode')) {
                updateServerStatus("online");
            } else if(log.includes('accept') && log.includes('EULA')) {
                ipcRenderer.send('send-input', "yes");
            } else if(log.includes('edit') && log.includes('keep')) {
                ipcRenderer.send('send-input', "keep");
            } else if(log.includes('this') && log.includes('global')) {
                ipcRenderer.send('send-input', "this");
            } else if(log.includes('Game') && log.includes('version')) {
                let str = log;
                let match = str.match(/(\d+\.\d+\.\d+)/);
                if (match) {
                    gameVersion = match[0];
                    const versionText = document.getElementById("gameVersion");
                    versionText.textContent = gameVersion;
                }
            }
        });

        function getFormattedTimestamp() {
            const now = new Date();
            const hours = String(now.getHours()).padStart(2, '0');
            const minutes = String(now.getMinutes()).padStart(2, '0');
            const seconds = String(now.getSeconds()).padStart(2, '0');
            const milliseconds = String(now.getMilliseconds()).padStart(3, '0');
            return `${hours}:${minutes}:${seconds}.${milliseconds}`;
        }

        // Handle server exit
        ipcRenderer.on('server-exit', (event, message) => {
            logBox.innerHTML += '<br><br>' + message + '<br>';
            document.getElementById("console-output").scrollTop = document.getElementById("console-output").scrollHeight; // Auto-scroll to the bottom
            updateServerStatus("offline")

            clearInterval(uptimeInterval); // Clear the interval on server stop
            startTime = null; // Reset the start time
            uptimeText.textContent = "N/A"; // Reset display
        });

        ipcRenderer.on('server-error', (event, message) => {
            logBox.innerHTML += '<p style="color:red;">' + message + '</p>';
            document.getElementById("console-output").scrollTop = document.getElementById("console-output").scrollHeight; // Auto-scroll to the bottom
            updateServerStatus("offline")
        
            clearInterval(uptimeInterval); // Clear the interval on server stop
            startTime = null; // Reset the start time
            uptimeText.textContent = "N/A"; // Reset display
        });        

        // Listen for the response from localadmin.exe
        ipcRenderer.on('active-players-response', (event, players) => {
            // Clear the existing list
            playersList.innerHTML = '';

            // Populate the list with active players
            players.forEach(player => {
                const li = document.createElement('li');
                li.textContent = player; // Assuming 'player' is a string
                playersList.appendChild(li);
            });
        });

        ipcRenderer.on('update-stats', (event, { cpu, memory }) => {
            var cpuEl = document.getElementById('cpu-usage')
            var cpuBar = document.getElementById('cpu-bar')
            var memoryEl = document.getElementById('memory-usage')
            if(cpuEl && memory){
                cpuEl.innerText = `CPU: ${cpu}%`;
                cpuBar.style = `width: ${cpu}%`;
                memoryEl.innerText = `RAM: ${memory} MB`;
            }
        });
    } else {
        console.error("HTML elements are missing. Please check the element IDs in index.html.");
    }
});