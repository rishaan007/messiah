import type { DeviceIdentity } from "../identity/deviceIdentity.js";

export interface IKeyStore {
  readonly name: string;
  loadIdentity(): Promise<DeviceIdentity | null>;
  saveIdentity(identity: DeviceIdentity): Promise<void>;
  deleteIdentity(): Promise<void>;
  isHardwareBacked?(): boolean;
}
