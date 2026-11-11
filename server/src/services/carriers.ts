// No integration is enabled until a carrier-specific, approved OAuth/API implementation exists.
// Adapters must use a fixed approved endpoint, never accept insurer passwords, and cannot
// assert verification or create a policy without real carrier evidence and human review.
export interface CarrierDescriptor {
  id: string
  name: string
  status: 'not_configured' | 'available'
}
export interface CarrierAdapter {
  readonly descriptor: CarrierDescriptor
  // Future adapters must implement approved authorization and evidence retrieval here.
}
const registry: CarrierAdapter[] = [
  { descriptor: { id: 'travelers', name: 'Travelers', status: 'not_configured' } },
  { descriptor: { id: 'the-hartford', name: 'The Hartford', status: 'not_configured' } },
  { descriptor: { id: 'nationwide', name: 'Nationwide', status: 'not_configured' } },
]
export function listCarriers(): CarrierDescriptor[] {
  return registry.map(({ descriptor }) => ({ ...descriptor }))
}
