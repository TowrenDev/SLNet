const { app, BrowserWindow, ipcMain, dialog, net, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { exec } = require('child_process');
const UpnpManager = require('./UpnpManager'); // Import the class
const upnpManager = new UpnpManager(); // Instantiate the class
const WebSocket = require('ws'); // Import the WebSocket library
const pidusage = require('pidusage');
const netServer = require('net');
const packageJson = require('./package.json');
const version = packageJson.version;

const DEFAULT_SERVER_PORT = 7777;
let mainWindow;
let serverProcess = null;
let webSocketServer = null;

let serverDirectory = null;
let serverPath = null;

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 800,
        height: 600,
        icon: path.join(__dirname, 'build/icon.ico'),
        webPreferences: {
            preload: path.join(__dirname, 'renderer.js'),
            nodeIntegration: true,
            contextIsolation: false,
            // devTools: false,
        }
    });

    mainWindow.loadFile('index.html');
    mainWindow.menuBarVisible = false;  

    // mainWindow.on("ready-to-show", () => {
    //     mainWindow.webContents.openDevTools();
    // }, 3000);

    mainWindow.on('closed', () => {
        if (serverProcess) serverProcess.kill();
        if (webSocketServer) webSocketServer.close();
        mainWindow = null;
    });

    // Send CPU and memory usage to renderer
    setInterval(() => {
        if (serverProcess) {
            pidusage(serverProcess.pid, (err, stats) => {
                if (err) {
                    console.error(err);
                    return;
                }

                const cpuUsage = stats.cpu.toFixed(2); // in %
                const memoryUsage = (stats.memory / 1024 / 1024).toFixed(2); // in MB

                // Send data to renderer process
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send('update-stats', { cpu: cpuUsage, memory: memoryUsage });
                }
            });
        }
    }, 1000); // every second
}

async function handleUpnpError(error) {
    mainWindow.webContents.send('server-log', `UPnP unsuccessful. Creating crash log...\n`);
    // Create "crashes" directory if it doesn't exist
    const crashesDir = path.join(__dirname, 'crashes');
    if (!fs.existsSync(crashesDir)) {
        fs.mkdirSync(crashesDir);
    }

    // Create a log file with the error message
    const errorFilePath = path.join(crashesDir, `crash_${Date.now()}.txt`);
    fs.writeFileSync(errorFilePath, error.toString());

    // Show a dialog to the user
    const result = await dialog.showMessageBox({
        type: 'error',
        buttons: ['OK'],
        title: 'UPnP Error',
        message: 'UPnP has failed to open or close the port.\n\n' +
            'Please make sure UPnP is enabled on your router.\n' +
            `Crash logged: ${errorFilePath}`,
    });

    // Quit the application after acknowledgment
    if (result.response === 0) {
        serverProcess.kill();
        serverProcess = null;
        app.quit(); // Use `app.quit()` if this is in the main process
    }
}

// Function to start WebSocket server
function startWebSocketServer() {
    webSocketServer = new WebSocket.Server({ port: DEFAULT_SERVER_PORT }); // Change the port as needed

    webSocketServer.on('connection', (ws) => {
        console.log('New WebSocket connection established.');

        ws.on('message', (message) => {
            console.log(`Received message: ${message}`);
            // Handle incoming messages
            if (message === 'get-players') {
                // Send active players list to the client
                sendActivePlayers(ws);
            }
            // Additional message handling as needed
        });

        ws.on('close', () => {
            console.log('WebSocket connection closed.');
        });
    });

    webSocketServer.on('error', (error) => {
        console.error('WebSocket server error:', error);
    });

    console.log('WebSocket server started on port 8080.');
}

const MAX_RETRIES = 3; // Maximum number of retries for opening/closing ports
const RETRY_DELAY = 1000; // Delay between retries in milliseconds

function isPortAvailable(port) {
    return new Promise((resolve) => {
        const tester = netServer.createServer()
            .once('error', (err) => (err.code === 'EADDRINUSE' ? resolve(false) : resolve(true)))
            .once('listening', () => tester.once('close', () => resolve(true)).close())
            .listen(port);
    });
}

// Function to start server with UPnP port mapping
async function startServerWithPortMapping() {
    const portAvailable = await isPortAvailable(7777);
    if (!portAvailable) {
        console.log("Port 7777 is in use. Attempting to close...");
        stopServerWithPortUnmapping(); // Ensure the server is stopped to release the port
        setTimeout(startServerWithPortMapping, 1000); // Wait briefly before trying again
        return;
    }

    let attempts = 0;
    while (attempts < MAX_RETRIES) {
        try {
            await upnpManager.openPort(DEFAULT_SERVER_PORT);
            console.log(`Server is running on port ${DEFAULT_SERVER_PORT} with UPnP port mapping.`);
            mainWindow.webContents.send('server-log', `UPnP successful. Port ${DEFAULT_SERVER_PORT} opened successfully!\n`);
            startWebSocketServer();
            return; // Exit the function if successful
        } catch (err) {
            attempts++;
            console.error(`Attempt ${attempts} to open port ${DEFAULT_SERVER_PORT} failed. Error: ${err.message}`);
            await new Promise(resolve => setTimeout(resolve, RETRY_DELAY)); // Wait before retrying
        }
    }
    // After all attempts, handle the error
    await handleUpnpError(new Error(`Failed to open port ${DEFAULT_SERVER_PORT} after ${MAX_RETRIES} attempts.`));
}

// Function to stop server and close UPnP port mapping
async function stopServerWithPortUnmapping() {
    let attempts = 0;
    
    // First, stop the WebSocket server (if necessary)
    if (webSocketServer) {
        webSocketServer.close(); // Close the WebSocket server
        console.log('WebSocket server closed.');
    }
    
    // Optional: wait a moment before closing the port
    await new Promise(resolve => setTimeout(resolve, 1000)); // 1-second delay

    while (attempts < MAX_RETRIES) {
        try {
            await upnpManager.closePort(DEFAULT_SERVER_PORT);
            console.log(`Server on port ${DEFAULT_SERVER_PORT} has stopped and UPnP port mapping removed.`);
            mainWindow.webContents.send('server-log', `UPnP successful. Port ${DEFAULT_SERVER_PORT} closed successfully!\n`);
            return; // Exit the function if successful
        } catch (err) {
            attempts++;
            console.error(`Attempt ${attempts} to close port ${DEFAULT_SERVER_PORT} failed. Error: ${err.message}`);
            await new Promise(resolve => setTimeout(resolve, RETRY_DELAY)); // Wait before retrying
        }
    }
    // After all attempts, handle the error
    await handleUpnpError(new Error(`Failed to close port ${DEFAULT_SERVER_PORT} after ${MAX_RETRIES} attempts.`));
}

app.on('ready', async () => {
    createWindow();

    if (fs.existsSync(configFilePath)) {
        const configData = fs.readFileSync(configFilePath, 'utf-8');
        const parsedConfig = JSON.parse(configData);
        console.log(`Loaded server path: ${parsedConfig.serverPath}`);
        serverDirectory = parsedConfig.serverPath;
        serverPath = path.join(parsedConfig.serverPath, 'LocalAdmin.exe');
        console.log(`Loaded local admin path: ${serverPath}`);
    } else {
        installServerDialog();
    }
    return null; // or return a default path if desired
});

function showMessageBoxWithLink(curVer, newVer) {
    dialog.showMessageBox({
        type: 'info',
        icon: path.join(__dirname, 'towren.ico'),
        title: 'Update Available',
        message: `${newVer} is the latest release. You are currently running ${curVer}, which may be unstable or outdated. Please update to ensure the latest features and patches.`,
        buttons: ['OK', 'Download Here']
    }).then((result) => {
        if (result.response === 1) {
            shell.openExternal('https://slnet.netlify.app');
        }
    });
}

function isVersionLower(currentVersion, newVersion) {
    const currentParts = currentVersion.split('.').map(Number);
    const newParts = newVersion.split('.').map(Number);

    for (let i = 0; i < Math.max(currentParts.length, newParts.length); i++) {
        const current = currentParts[i] || 0;
        const latest = newParts[i] || 0;
        if (current < latest) return true;
        if (current > latest) return false;
    }
    return false;
}

app.whenReady().then(() => {
    ipcMain.handle('get-external-ip', async () => {
        return new Promise((resolve, reject) => {
            const request = net.request('https://api.ipify.org?format=json');

            request.on('response', (response) => {
                let data = '';

                response.on('data', (chunk) => {
                    data += chunk;
                });

                response.on('end', () => {
                    try {
                        const json = JSON.parse(data);
                        resolve(json.ip); // Resolve with the IP address
                    } catch (error) {
                        reject('Error parsing response data');
                    }
                });
            });

            request.on('error', (error) => {
                reject(`Error fetching external IP: ${error.message}`);
            });

            request.end(); // Send the request
        });
    });

    ipcMain.handle('get-logs-dir', () => {
        return logsDir;
    });

    ipcMain.handle('get-server-dir', () => {
        return serverDirectory;
    });

    ipcMain.on('download-log', async (event, { name, path: logPath }) => {
        const { canceled, filePath } = await dialog.showSaveDialog({
            defaultPath: name,
            filters: [{ name: 'Text Files', extensions: ['txt'] }],
        });
    
        if (!canceled && filePath) {
            fs.copyFileSync(logPath, filePath);
        }
    });

    ipcMain.on('set-theme', (event, theme) => {
        saveConfigField('theme', theme);
        event.reply('theme-saved', theme);
    });

    ipcMain.handle('get-theme', () => {
        const config = readConfig();
        return config.theme || 'dark';
    });

    // Function to check the application version
    async function checkVersion() {
        const response = await fetch("https://slnet.netlify.app/version.json");
        const data = await response.json();

        if (isVersionLower(version, data.version)) {
            showMessageBoxWithLink(version, data.version);
        }
    }

    checkVersion();
});

// Function to install the server via Steam
function installServer() {
    const steamUrl = 'steam://install/996560';

    // Open the Steam URL in the default browser
    exec(`start ${steamUrl}`, (err) => {
        if (err) {
            console.error('Failed to open Steam install URL:', err);
            return;
        }
        console.log('Opening Steam to install SCP: Secret Laboratory Dedicated Server...');
    });
}

function getConfigPath(port) {
    const homeDir = os.homedir(); // Get the home directory of the current user
    return path.join(homeDir, 'AppData', 'Roaming', 'SCP Secret Laboratory', 'config', port.toString());
}

function listServerPorts() {
    const scpDir = path.join(os.homedir(), 'AppData', 'Roaming', 'SCP Secret Laboratory', 'config');

    // Read the directory contents
    fs.readdir(scpDir, { withFileTypes: true }, (err, files) => {
        if (err) {
            console.error('Error reading directory:', err);
            return;
        }

        // Filter for directories and log their names
        const portFolders = files
            .filter(file => file.isDirectory()) // Only get directories
            .map(folder => folder.name) // Get the folder names
            .filter(folderName => !isNaN(folderName)); // Ensure folder names are numeric (port numbers)

        console.log('Available server ports:', portFolders);
    });
}

// async function installServerDialog() {
//     const response = await dialog.showMessageBox(mainWindow, {
//         type: 'question',
//         buttons: ['Yes', 'No'],
//         icon: path.join(__dirname, 'towren.ico'),
//         title: 'Install Server',
//         message: 'SCP: Secret Laboratory Dedicated Server directory was not found',
//         detail: "Would you like to install it now?",
//     });

//     if (response.response === 0) { // User clicked 'Yes'
//         installServer();
//     }
// }

const logsDir = path.join(app.getPath('userData'), 'logs');

ipcMain.on('save-console-logs', (event, logContent) => {
    // Ensure the logs directory exists
    if (!fs.existsSync(logsDir)) {
        fs.mkdirSync(logsDir);
    }

    // Generate filename with timestamp
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const logFilePath = path.join(logsDir, `log-${timestamp}.txt`);

    // Save log content to the file
    fs.writeFile(logFilePath, logContent, 'utf-8', (err) => {
        if (err) {
            console.error('Failed to save log:', err);
            mainWindow.webContents.send('log-saved', `Failed to save console log: ${logFilePath}`);
            return;
        }
        console.log(`Log saved to ${logFilePath}`);
        mainWindow.webContents.send('log-saved', `Console log saved successfully: ${logFilePath}`);
    });
});

const configFilePath = path.join(app.getPath('userData'), 'config.json');
console.log(configFilePath)

function createConfigFile() {
    if (!fs.existsSync(configFilePath)) {
        const initialConfig = { serverPath: '' }; // Initial empty serverPath
        fs.writeFileSync(configFilePath, JSON.stringify(initialConfig, null, 2), 'utf-8');
        console.log(`Configuration file created: ${configFilePath}`);
    }
}

function readConfig() {
    createConfigFile();
    const data = fs.readFileSync(configFilePath, 'utf-8');
    return JSON.parse(data);
}

function saveConfigField(field, value) {
    createConfigFile();
    const configData = readConfig();
    configData[field] = value;
    fs.writeFileSync(configFilePath, JSON.stringify(configData, null, 2), 'utf-8');
    console.log(`Updated config: ${field} = ${value}`);
}

// Function to save the server path to the configuration file
function saveServerPathToConfig(selectedPath) {
    // Ensure the config file exists before saving
    // createConfigFile();

    // const configData = { serverPath: selectedPath };

    // fs.writeFileSync(configFilePath, JSON.stringify(configData, null, 2), 'utf-8');
    // console.log(`Configuration updated: ${configFilePath}`);
    saveConfigField(serverPath, selectedPath)
}

function installServerDialog() {
    dialog.showOpenDialog({
        title: 'Select SCP Secret Laboratory Dedicated Server Installation Folder',
        properties: ['openDirectory']
    }).then(result => {
        if (!result.canceled) {
            const userSelectedPath = result.filePaths[0];
            console.log(`User selected path: ${userSelectedPath}`);

            // Constant for the server installation path
            serverDirectory = userSelectedPath;
            saveServerPathToConfig(userSelectedPath);

            // Constant for LocalAdmin.exe
            serverPath = path.join(userSelectedPath, 'LocalAdmin.exe');

            // Example usage
            console.log(`Server installation path: ${userSelectedPath}`);
            console.log(`LocalAdmin.exe path: ${serverPath}`);

            // Proceed with your logic here, using SERVER_INSTALL_PATH and LOCAL_ADMIN_PATH
        }
    }).catch(err => {
        console.error(err);
    });
}

console.log('Server Path:', serverPath);
console.log('Working Directory:', serverDirectory);

// Handle starting the server
ipcMain.on('start-server', (event, port) => {
    if (!serverProcess) {
        const serverExists = fs.existsSync(serverPath);
        if (!serverExists) {
            shell.openExternal('steam://install/996560');
            event.reply('server-error', 'Server executable not found. Please reinstall or reconfigure the server path. After installing, restart SLNet.');
            return;
        }

        // Create arguments array including the port if provided
        const args = port ? [port] : []; // Default to empty array if no port is provided
        startServerWithPortMapping();

        serverProcess = spawn(serverPath, ['--port', port, '--color', '--interactive-flag'], {
            detached: false,
            stdio: ['pipe', 'pipe', 'pipe'],
            cwd: serverDirectory,
            env: { ...process.env, FORCE_COLOR: '1' },
        });

        serverProcess.stdout.on('data', (data) => {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('server-log', data.toString('utf8'));
            }
        });

        serverProcess.stderr.on('data', (data) => {
            if (mainWindow && !mainWindow.isDestroyed()) {
                const errorMessage = `Error: ${data.toString('utf8')}`;
                mainWindow.webContents.send('server-log', errorMessage);

                // Optionally reset the server process on critical errors
                if (errorMessage.includes('unhandled exception')) {
                    console.error('Unhandled exception occurred. Restarting server...');
                    stopServerWithPortUnmapping(); // Your function to handle server stop
                    // Optionally restart the server or notify the user
                }
            }
        });

        serverProcess.on('exit', (code) => {
            console.error(`Server stopped with exit code: ${code}`);
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('server-exit', `Server stopped with exit code: ${code}`);
                serverProcess = null;
            }
            isCommandProcessing = false; // Reset command processing state
        });
    }
});

// Handle stopping the server
ipcMain.on('stop-server', () => {
    if (serverProcess) {
        stopServerWithPortUnmapping();
        serverProcess.kill();
        serverProcess = null;
    }
});

// Handle input from renderer and send to server's stdin
ipcMain.on('send-input', (event, input) => {
    if (serverProcess && serverProcess.stdin.writable) {
        serverProcess.stdin.write(input + '\n');
    }
});

ipcMain.on('change-directory', (event) => {
    installServerDialog()
})