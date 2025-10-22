import { type ComposeConfig, type InstallConfiguration } from "../../types";
import { GUEST_API_PORT, GUEST_NOVNC_PORT, RESTART_ON_FAILURE, WINBOAT_DIR } from "./constants";
import { ref, type Ref } from "vue";
import { createLogger } from "../utils/log";
import { createNanoEvents, type Emitter } from "nanoevents";
import { PortManager } from "../utils/port";
import { ContainerManager } from "./containers/container";
import { WinboatConfig } from "./config";
import { createContainer } from "./containers/common";
const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');
const nodeFetch: typeof import('node-fetch').default = require('node-fetch');
const remote: typeof import('@electron/remote') = require('@electron/remote');

const logger = createLogger(path.join(WINBOAT_DIR, 'install.log'));

export const InstallStates = {
    IDLE: 'Preparing',
    CREATING_COMPOSE_FILE: 'Creating Compose File',
    CREATING_OEM: "Creating OEM Assets",
    STARTING_CONTAINER: 'Starting Container',
    MONITORING_PREINSTALL: 'Monitoring Preinstall',
    INSTALLING_WINDOWS: 'Installing Windows',
    COMPLETED: 'Completed',
    INSTALL_ERROR: 'Install Error'
} as const;

export type InstallState = typeof InstallStates[keyof typeof InstallStates];
interface InstallEvents {
    stateChanged: (state: InstallState) => void;
    preinstallMsg: (msg: string) => void;
    error: (error: Error) => void;
}

export class InstallManager {
    conf: InstallConfiguration;
    emitter: Emitter<InstallEvents>;
    state: InstallState;
    preinstallMsg: string;
    container: ContainerManager;
    portMgr: Ref<PortManager | null>;

    constructor(conf: InstallConfiguration) {
        this.conf = conf;
        this.state = InstallStates.IDLE;
        this.preinstallMsg = ""
        this.emitter = createNanoEvents<InstallEvents>();
        this.portMgr = ref(null);
        this.container = conf.container;
    }

    changeState(newState: InstallState) {
        this.state = newState;
        this.emitter.emit('stateChanged', newState);
        logger.info(`New state: "${newState}"`);
    }

    setPreinstallMsg(msg: string) {
        if (msg === this.preinstallMsg) return;
        this.preinstallMsg = msg;
        this.emitter.emit('preinstallMsg', msg);
        logger.info(`Preinstall: "${msg}"`);
    }

    sleep(ms: number) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    async createComposeFile() {
        this.changeState(InstallStates.CREATING_COMPOSE_FILE);

        // Ensure the .winboat directory exists
        if (!fs.existsSync(WINBOAT_DIR)) {
            fs.mkdirSync(WINBOAT_DIR);
            logger.info(`Created WinBoat directory: ${WINBOAT_DIR}`);
        }

        // Ensure the installation directory exists
        if (!fs.existsSync(this.conf.installFolder)) {
            fs.mkdirSync(this.conf.installFolder, { recursive: true });
            logger.info(`Created installation directory: ${this.conf.installFolder}`);
        }

        // Configure the compose file
        const composeContent = this.container.defaultCompose;
        this.portMgr.value = await PortManager.parseCompose(composeContent);

        composeContent.services.windows.ports = this.portMgr.value.composeFormat;
        composeContent.services.windows.environment.RAM_SIZE = `${this.conf.ramGB}G`;
        composeContent.services.windows.environment.CPU_CORES = `${this.conf.cpuCores}`;
        composeContent.services.windows.environment.DISK_SIZE = `${this.conf.diskSpaceGB}G`;
        composeContent.services.windows.environment.VERSION = this.conf.windowsVersion;
        composeContent.services.windows.environment.LANGUAGE = this.conf.windowsLanguage;
        composeContent.services.windows.environment.USERNAME = this.conf.username;
        composeContent.services.windows.environment.PASSWORD = this.conf.password;
        
        // Boot image mapping
        if (this.conf.customIsoPath) {
            composeContent.services.windows.volumes.push(`${this.conf.customIsoPath}:/boot.iso`);
        }

        // Storage folder mapping
        const storageFolderIdx = composeContent.services.windows.volumes.findIndex(vol => vol.includes('/storage'));
        if (storageFolderIdx !== -1) {
            composeContent.services.windows.volumes[storageFolderIdx] = `${this.conf.installFolder}:/storage`;
        } else {
            logger.warn("No /storage volume found in compose template, adding one...");
            composeContent.services.windows.volumes.push(`${this.conf.installFolder}:/storage`);
        }

        // Home folder mapping
        if (!this.conf.shareHomeFolder) {
            const sharedFolderIdx = composeContent.services.windows.volumes.findIndex(vol => vol.includes('/shared'));
            if (sharedFolderIdx !== -1) {
                composeContent.services.windows.volumes.splice(sharedFolderIdx, 1);
                logger.info("Removed home folder sharing as per user configuration");
            } else {
                logger.info("No home folder sharing volume found, nothing to remove");
            }
        }

        // Write the compose file
        this.container.writeCompose(composeContent);
    }

    createOEMAssets() {
        this.changeState(InstallStates.CREATING_OEM);
        logger.info("Creating OEM assets");

        const oemPath = path.join(WINBOAT_DIR, 'oem'); // Fixed the path separator

        // Create OEM directory if it doesn’t exist
        if (!fs.existsSync(oemPath)) {
            fs.mkdirSync(oemPath, { recursive: true });
            logger.info(`Created OEM directory: ${oemPath}`);
        }

        // Determine the source path based on whether the app is bundled
        const appPath = remote.app.isPackaged 
            ? path.join(process.resourcesPath, 'guest_server') // For packaged app
            : path.join(remote.app.getAppPath(), '..', '..', 'guest_server'); // For dev mode

        logger.info(`Guest server source path: ${appPath}`);

        // Check if the source directory exists
        if (!fs.existsSync(appPath)) {
            const error = new Error(`Guest server directory not found at: ${appPath}`);
            logger.error(error.message);
            throw error;
        }

        const copyRecursive = (src: string, dest: string) => {
            const stats = fs.statSync(src);
            
            if (stats.isDirectory()) {
                // Create directory if it doesn't exist
                if (!fs.existsSync(dest)) {
                    fs.mkdirSync(dest, { recursive: true });
                }
                
                // Copy all contents
                fs.readdirSync(src).forEach(entry => {
                    const srcPath = path.join(src, entry);
                    const destPath = path.join(dest, entry);
                    copyRecursive(srcPath, destPath);
                });
                
                logger.info(`Copied directory ${src} to ${dest}`);
            } else {
                // Copy file
                fs.copyFileSync(src, dest);
                logger.info(`Copied file ${src} to ${dest}`);
            }
        };

        // Copy all files from guest_server to oemPath
        try {
            fs.readdirSync(appPath).forEach(entry => {
                const srcPath = path.join(appPath, entry);
                const destPath = path.join(oemPath, entry);
                copyRecursive(srcPath, destPath);
            });
            logger.info("OEM assets created successfully");
        } catch (error) {
            logger.error(`Failed to copy OEM assets: ${error}`);
            throw error;
        }
    }

    async startContainer() {
        this.changeState(InstallStates.STARTING_CONTAINER);
        logger.info('Starting container...');

        // Start the container
        await this.container.compose("up");
        logger.info('Container started successfully.');
    }

    async monitorContainerPreinstall() {
        // Sleep a bit to make sure the webserver is up in the container
        await this.sleep(3000);

        this.changeState(InstallStates.MONITORING_PREINSTALL);
        logger.info('Starting preinstall monitoring...');

        while (true) {
            try {
                const vncHostPort = this.portMgr.value!.getHostPort(GUEST_NOVNC_PORT);
                const response = await nodeFetch(`http://127.0.0.1:${vncHostPort}/msg.html`, { signal: AbortSignal.timeout(500) });
                if (response.status === 404) {
                    logger.info('Received 404, preinstall completed');
                    return; // Exit the method when we get 404
                }
                const message = await response.text();
                const re = />([^<]+)</;
                const messageFormatted = message.match(re)?.[1] || message;
                this.setPreinstallMsg(messageFormatted);
            } catch (error) {
                if (error instanceof Error && error.message.includes('404')) {
                    logger.info('Received 404, preinstall completed');
                    return; // Exit the method when fetch throws 404
                }
                logger.error(`Error monitoring container: ${error}`);
                throw error;
            }

            // Wait 500ms before next check
            await this.sleep(500);
        }
    }

    async monitorAPIHealth() {
        this.changeState(InstallStates.INSTALLING_WINDOWS);
        logger.info("Waiting for WinBoat Guest Server to wrap up installation...");

        let attempts = 0;

        while (true) {
            const start = performance.now();
            try {
                const apiHostPort = this.portMgr.value!.getHostPort(GUEST_API_PORT);

                const res = await nodeFetch(`http://127.0.0.1:${apiHostPort}/health`, { signal: AbortSignal.timeout(5000) });
                if (res.status === 200) {
                    logger.info("WinBoat Guest Server is up and healthy!");
                    this.changeState(InstallStates.COMPLETED);
                    return;
                }

                logger.log(`API request status: ${res.status}`);
            } catch (error) {
                // We can ignore the AbortError resulting from the timeout
                if(!(error instanceof nodeFetch.AbortError)) {
                    logger.error(error);
                }
            }

            if (++attempts % 12 === 0) {
                logger.info(`API not responding yet, still waiting after ${attempts * 5 / 60} minutes...`);
            }
            this.sleep(5000 - (performance.now() - start));
        }
    }

    async install() {
        logger.info('Starting installation...');
        
        try {
            await this.createComposeFile();
            this.createOEMAssets();
            await this.startContainer();
            await this.monitorContainerPreinstall();
            await this.monitorAPIHealth();
        }
        catch(e) {
            this.changeState(InstallStates.INSTALL_ERROR);
            logger.error("Errors encountered, could not complete the installation steps.")
            return;
        }
        this.changeState(InstallStates.COMPLETED);

        logger.info('Installation completed successfully.');
    }
}

export async function isInstalled(): Promise<boolean> {
    // Check if a winboat container exists
    const configInstance = new WinboatConfig({ instantiateAsSingleton: false });
    const config = configInstance.readConfig()

    if(!config) return false

    const containerRuntime = createContainer(config.containerRuntime);

    return await containerRuntime.exists();
}
