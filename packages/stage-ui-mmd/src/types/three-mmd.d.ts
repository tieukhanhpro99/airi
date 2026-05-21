declare module '@moeru/three-mmd' {
  import type { AnimationClip, LoadingManager, SkinnedMesh } from 'three'

  export interface MMD {
    mesh: SkinnedMesh & {
      morphTargetDictionary?: Record<string, number>
      morphTargetInfluences?: number[]
    }
    update: (delta: number) => void
  }

  export class MMDLoader {
    constructor(resourcePath?: string[], manager?: LoadingManager)
    loadAsync(url: string, onProgress?: (event: ProgressEvent) => void): Promise<MMD>
    load(
      url: string,
      onLoad: (mmd: MMD) => void,
      onProgress?: (event: ProgressEvent) => void,
      onError?: (event: ErrorEvent) => void,
    ): void
  }

  export class VMDLoader {
    loadAsync(url: string): Promise<unknown>
  }

  export function buildAnimation(vmdData: unknown, mesh: MMD['mesh']): AnimationClip
}
