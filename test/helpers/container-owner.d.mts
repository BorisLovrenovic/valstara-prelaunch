export interface ContainerOwner {
  host: string;
  bootId: string;
  pidNamespace: string;
  pid: string;
}

export declare const containerOwnerLabels: Readonly<
  Record<keyof ContainerOwner, string>
>;

export function currentContainerOwner(): ContainerOwner;

export function containerOwnerArguments(owner?: ContainerOwner): string[];

export function processIsRunning(pid: number): boolean;

export function containerOwnerIsGone(
  labels: ContainerOwner,
  options?: { owner?: ContainerOwner; isRunning?: (pid: number) => boolean },
): boolean;

export function removeOrphanedContainers(options?: {
  docker?: (args: string[]) => Promise<string>;
  owner?: ContainerOwner;
  isRunning?: (pid: number) => boolean;
}): Promise<string[]>;
