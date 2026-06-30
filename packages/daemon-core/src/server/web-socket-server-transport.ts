import type { DaemonWebSocket, ServerTransport } from './types';

export class WebSocketServerTransport implements ServerTransport {
  private readonly ws: DaemonWebSocket;

  public constructor(ws: DaemonWebSocket) {
    this.ws = ws;
  }

  send(message: string): void {
    this.ws.send(message);
  }

  isOpen(): boolean {
    return this.ws.readyState === WebSocket.OPEN;
  }

  close(): void {
    this.ws.close();
  }

  getWebSocket(): DaemonWebSocket {
    return this.ws;
  }
}
