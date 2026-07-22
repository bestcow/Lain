import type { EngineCapabilityInfo, TaskEngine } from '../../shared/types'

export function engineInfoFor(
  infos: EngineCapabilityInfo[],
  engine: TaskEngine,
): EngineCapabilityInfo | undefined {
  return infos.find((i) => i.engine === engine)
}

export function EngineBadge({
  engine,
  info,
  observed = false,
}: {
  engine: TaskEngine
  info?: EngineCapabilityInfo
  observed?: boolean
}) {
  return (
    <span className={`engine-badge engine-${engine}${observed ? ' engine-badge-observed' : ''}`} title={`${info?.label ?? engine} 엔진${observed ? ' · 관찰' : ''}`}>
      {info?.label ?? engine}
      {observed ? ' · 관찰' : ''}
    </span>
  )
}
