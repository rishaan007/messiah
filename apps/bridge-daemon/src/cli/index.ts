#!/usr/bin/env node
import { Command } from "commander";
import { BridgeClient } from "../connection/bridgeClient.js";
import { PairingClient } from "../pairing/pairingClient.js";
import { DiagnosticsService } from "../diagnostics/diagnosticsService.js";
import { getPlatformKeystore } from "../keystore/index.js";
import { DeviceIdentityManager } from "../identity/deviceIdentity.js";
import { askQuestion, askSecret } from "./prompt.js";

const program = new Command();

program
  .name("messiah-bridge")
  .description("MESSIAH Local Agent Bridge — One intelligence layer. Every agent. Every device.")
  .version(DeviceIdentityManager.VERSION);

// 1. messiah-bridge start
program
  .command("start")
  .description("Start the Messiah Local Agent Bridge daemon and maintain outbound connection")
  .option("--server <url>", "Override server URL")
  .action(async () => {
    console.log("================================================================================");
    console.log(" MESSIAH LOCAL AGENT BRIDGE");
    console.log(" One intelligence layer. Every agent. Every device.");
    console.log("================================================================================");

    const client = new BridgeClient();

    try {
      client.on("socket_open", () => {
        console.log("[Bridge] Outbound WebSocket connected. Awaiting server challenge...");
      });

      client.on("connected", (frame) => {
        console.log(`[Bridge] ✓ Authenticated with Messiah Cloud!`);
        console.log(`[Bridge] Device ID:   ${frame.deviceId}`);
        console.log(`[Bridge] Name:        ${frame.displayName}`);
        console.log(`[Bridge] Session ID:  ${frame.sessionId}`);
        console.log(`[Bridge] Heartbeat:   every ${frame.heartbeatIntervalMs / 1000}s`);
        console.log("[Bridge] Ready and listening for governed operations.");
      });

      client.on("auth_failed", (frame) => {
        console.error(`[Bridge] ✗ Authentication rejected by server: [${frame.code}] ${frame.message}`);
        if (frame.code === "DEVICE_PENDING_APPROVAL") {
          console.log("[Bridge] Please approve this device registration in your Messiah workspace settings (/settings/devices).");
        }
      });

      client.on("reconnecting", ({ attempt, delayMs }) => {
        console.log(`[Bridge] Reconnecting to server (attempt ${attempt}) in ${Math.round(delayMs / 1000)}s...`);
      });

      client.on("disconnected", ({ code, reason }) => {
        console.warn(`[Bridge] Disconnected (code: ${code}): ${reason}`);
      });

      client.on("revoked", (frame) => {
        console.error(`[Bridge] ⚠️ Device access has been revoked: ${frame.reason}`);
      });

      await client.start();

      // Graceful shutdown
      const shutdown = async () => {
        console.log("\n[Bridge] Shutting down daemon gracefully...");
        await client.stop();
        process.exit(0);
      };

      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
    } catch (err: unknown) {
      console.error(`[Bridge] Error starting daemon:`, err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

// 2. messiah-bridge pair
program
  .command("pair")
  .description("Pair this computer with a Messiah workspace using a one-time code (prompted via masked input)")
  .option("-s, --server <url>", "Messiah server URL", "http://localhost:3001")
  .option("-n, --name <name>", "Custom display name for this device")
  .action(async (opts) => {
    console.log("================================================================================");
    console.log(" MESSIAH LOCAL AGENT BRIDGE — PAIRING WIZARD");
    console.log("================================================================================");

    try {
      let serverUrl = opts.server;
      if (!serverUrl) {
        serverUrl = await askQuestion("Messiah Server URL", "http://localhost:3001");
      }

      // Security Correction B: Never accept pairing secret via CLI flags or arguments (prevents ps, shell history, and log leaks)
      const pairingCode = await askSecret("Enter the 256-bit Pairing Code from /settings/devices (hidden input)");

      if (!pairingCode || pairingCode.trim().length < 6) {
        console.error("[Pairing] Invalid pairing code.");
        process.exit(1);
      }

      const displayName = opts.name;

      console.log(`[Pairing] Contacting Messiah server at ${serverUrl}...`);
      const pairingClient = new PairingClient();
      const result = await pairingClient.pair(serverUrl, pairingCode, displayName);

      console.log("\n✓ Device pairing request submitted successfully!");
      console.log(`Device ID:    ${result.identity.deviceId}`);
      console.log(`Display Name: ${result.identity.displayName}`);
      console.log(`Fingerprint:  ${result.identity.publicKeyFingerprint}`);
      console.log(`Status:       PENDING APPROVAL`);
      console.log("\nNext step: Open Messiah -> Settings -> Devices (/settings/devices) and click 'Approve Device'.");
      console.log("After approving, run `messiah-bridge start` to connect.");
    } catch (err: unknown) {
      console.error(`[Pairing] Failed:`, err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

// 3. messiah-bridge status
program
  .command("status")
  .description("Display local device identity, pairing status, and keystore details")
  .action(async () => {
    const keystore = getPlatformKeystore();
    const pairingClient = new PairingClient(keystore);
    const identity = await keystore.loadIdentity();
    const config = pairingClient.getSavedConfig();

    console.log("================================================================================");
    console.log(" MESSIAH LOCAL AGENT BRIDGE STATUS");
    console.log("================================================================================");
    console.log(`Bridge Version:    ${DeviceIdentityManager.VERSION}`);
    console.log(`Keystore Engine:   ${keystore.name}`);
    console.log(`Hardware-Backed:   ${keystore.isHardwareBacked ? keystore.isHardwareBacked() : false}`);

    if (identity) {
      console.log(`\nDevice ID:         ${identity.deviceId}`);
      console.log(`Display Name:      ${identity.displayName}`);
      console.log(`Platform:          ${identity.platform} (${identity.architecture})`);
      console.log(`Public Key Hash:   ${identity.publicKeyFingerprint}`);
      console.log(`Registered At:     ${identity.createdAt}`);
    } else {
      console.log("\nDevice Identity:   Not initialized (No Ed25519 keypair found)");
    }

    if (config) {
      console.log(`\nPaired Server:     ${config.serverUrl}`);
      console.log(`Paired At:         ${config.pairedAt}`);
      console.log("Status:            CONFIGURED (Run `messiah-bridge start` to connect)");
    } else {
      console.log("\nPairing Status:    NOT PAIRED (Run `messiah-bridge pair` to pair)");
    }
  });

// 4. messiah-bridge unpair
program
  .command("unpair")
  .description("Remove local device registration and delete keys from keystore")
  .option("-f, --force", "Force unpair without confirmation")
  .action(async (opts) => {
    if (!opts.force) {
      const confirm = await askQuestion("Are you sure you want to unpair this device and purge local keys? (y/N)");
      if (confirm.toLowerCase() !== "y" && confirm.toLowerCase() !== "yes") {
        console.log("Aborted.");
        return;
      }
    }

    const pairingClient = new PairingClient();
    await pairingClient.unpair();
    console.log("✓ Device unpaired. Local identity and configuration successfully purged.");
  });

// 5. messiah-bridge diagnostics
program
  .command("diagnostics")
  .description("Perform comprehensive local environment, security, and connectivity audit")
  .action(async () => {
    console.log("[Diagnostics] Running diagnostics audit...\n");
    const service = new DiagnosticsService();
    const report = await service.runDiagnostics();

    console.log(JSON.stringify(report, null, 2));
  });

program.parse(process.argv);
