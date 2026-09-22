export interface SessionToken { type: string; identityId: string; exp: number }
export interface RoomTicket { type: string; roomId: string; identityId: string; peerId: number; reservationId: string; pool: string; exp: number; anonymous?: boolean }
