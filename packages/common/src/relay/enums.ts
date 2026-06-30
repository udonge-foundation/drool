export enum RelayFrameType {
  Text = 'text',
  Binary = 'binary',
}

export enum RelayEnvelopeType {
  ClientConnected = 'client_connected',
  ClientDisconnected = 'client_disconnected',
  ClientFrame = 'client_frame',
  TunnelClientConnected = 'tunnel_client_connected',
  TunnelClientDisconnected = 'tunnel_client_disconnected',
  TunnelClientFrame = 'tunnel_client_frame',
}

export enum RelayAuthMethod {
  AUTHENTICATE = 'relay.authenticate',
}

export enum RelayAuthResponseType {
  AuthOk = 'relay.auth_ok',
  AuthError = 'relay.auth_error',
}

export enum RelayControlType {
  Ping = 'relay.ping',
  Pong = 'relay.pong',
}
