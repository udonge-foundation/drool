// TODO: Consolidate with MachineConnectionType from @industry/common/session
export enum MachineType {
  Local = 'local',
  Ephemeral = 'ephemeral',
  Computer = 'computer',
}

export enum DesktopDaemonTransportMode {
  Ipc = 'ipc',
  WebSocket = 'websocket',
}

export enum DesktopDaemonDisconnectReason {
  ProcessExit = 'process_exit',
  ProcessStopped = 'process_stopped',
}
