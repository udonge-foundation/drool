import { DaemonListenMode } from '@/entrypoints/daemon/enums';

export const DAEMON_LISTEN_MODE_VALUES = [
  DaemonListenMode.WebSocket,
  DaemonListenMode.Ipc,
];
