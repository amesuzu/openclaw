import { Buffer } from "node:buffer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { captureEnv } from "../test-utils/env.js";

const wsInstances = vi.hoisted((): MockWebSocket[] => []);
const clearDeviceAuthTokenMock = vi.hoisted(() => vi.fn());
const loadDeviceAuthTokenMock = vi.hoisted(() => vi.fn());
const storeDeviceAuthTokenMock = vi.hoisted(() => vi.fn());
const clearDevicePairingMock = vi.hoisted(() => vi.fn());
const logDebugMock = vi.hoisted(() => vi.fn());
const logErrorMock = vi.hoisted(() => vi.fn());

type WsEvent = "open" | "message" | "close" | "error";
type WsEventHandlers = {
  open: () => void;
  message: (data: string | Buffer) => void;
  close: (code: number, reason: Buffer) => void;
  error: (err: unknown) => void;
};

class MockWebSocket {
  private openHandlers: WsEventHandlers["open"][] = [];
  private messageHandlers: WsEventHandlers["message"][] = [];
  private closeHandlers: WsEventHandlers["close"][] = [];
  private errorHandlers: WsEventHandlers["error"][] = [];
  readonly sent: string[] = [];

  constructor(_url: string, _options?: unknown) {
    wsInstances.push(this);
  }

  on(event: "open", handler: WsEventHandlers["open"]): void;
  on(event: "message", handler: WsEventHandlers["message"]): void;
  on(event: "close", handler: WsEventHandlers["close"]): void;
  on(event: "error", handler: WsEventHandlers["error"]): void;
  on(event: WsEvent, handler: WsEventHandlers[WsEvent]): void {
    switch (event) {
      case "open":
        this.openHandlers.push(handler as WsEventHandlers["open"]);
        return;
      case "message":
        this.messageHandlers.push(handler as WsEventHandlers["message"]);
        return;
      case "close":
        this.closeHandlers.push(handler as WsEventHandlers["close"]);
        return;
      case "error":
        this.errorHandlers.push(handler as WsEventHandlers["error"]);
        return;
      default:
        return;
    }
  }

  close(_code?: number, _reason?: string): void {}

  send(data: string): void {
    this.sent.push(data);
  }

  emitOpen(): void {
    for (const handler of this.openHandlers) {
      handler();
    }
  }

  emitMessage(data: string): void {
    for (const handler of this.messageHandlers) {
      handler(data);
    }
  }

  emitClose(code: number, reason: string): void {
    for (const handler of this.closeHandlers) {
      handler(code, Buffer.from(reason));
    }
  }
}

vi.mock("ws", () => ({
  WebSocket: MockWebSocket,
}));

vi.mock("../infra/device-auth-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/device-auth-store.js")>();
  return {
    ...actual,
    loadDeviceAuthToken: (...args: unknown[]) => loadDeviceAuthTokenMock(...args),
    storeDeviceAuthToken: (...args: unknown[]) => storeDeviceAuthTokenMock(...args),
    clearDeviceAuthToken: (...args: unknown[]) => clearDeviceAuthTokenMock(...args),
  };
});

vi.mock("../infra/device-pairing.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/device-pairing.js")>();
  return {
    ...actual,
    clearDevicePairing: (...args: unknown[]) => clearDevicePairingMock(...args),
  };
});

vi.mock("../logger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../logger.js")>();
  return {
    ...actual,
    logDebug: (...args: unknown[]) => logDebugMock(...args),
    logError: (...args: unknown[]) => logErrorMock(...args),
  };
});

const { GatewayClient } = await import("./client.js");

function getLatestWs(): MockWebSocket {
  const ws = wsInstances.at(-1);
  if (!ws) {
    throw new Error("missing mock websocket instance");
  }
  return ws;
}

describe("GatewayClient response errors", () => {
  const envSnapshot = captureEnv(["OPENCLAW_ALLOW_INSECURE_PRIVATE_WS"]);

  beforeEach(() => {
    envSnapshot.restore();
    wsInstances.length = 0;
  });

  it("rejects with an Error that preserves gateway error code and metadata", async () => {
    const client = new GatewayClient({ url: "ws://127.0.0.1:18789" });
    client.start();

    const ws = getLatestWs();
    ws.emitOpen();

    const p = client.request("device.pair.remove", { deviceId: "nope" });

    const sentReq = ws.sent.find((frame) => frame.includes('"type":"req"'));
    expect(sentReq).toBeTruthy();
    const req = JSON.parse(String(sentReq));

    ws.emitMessage(
      JSON.stringify({
        type: "res",
        id: req.id,
        ok: false,
        error: {
          code: "INVALID_REQUEST",
          message: "unknown deviceId",
          retryable: false,
        },
      }),
    );

    await expect(p).rejects.toMatchObject({
      message: "unknown deviceId",
      code: "INVALID_REQUEST",
      retryable: false,
    });
  });
});
