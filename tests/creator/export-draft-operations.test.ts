import { describe, expect, it, vi } from 'vitest'
import { createExportOperation } from '../../src/tools/export.ts'
import { createDraftOperation } from '../../src/tools/create-draft.ts'

const exec = () => ({ agent: undefined, callId: 'ui-call' as never, signal: new AbortController().signal })

describe('shared export and draft operations', () => {
  it('rejects unexpected export arguments before storage or approval',async()=>{
    const approval={request:vi.fn()};const store={read:vi.fn()}
    const run=createExportOperation({approval,store} as never)
    await expect(run({manifestPath:'x',previewReceiptId:'x',destinationPath:'/tmp/x',extra:true} as never,exec())).rejects.toThrow('unknown or missing arguments')
    expect(approval.request).not.toHaveBeenCalled();expect(store.read).not.toHaveBeenCalled()
  })
  it('validates export destination without tool-runtime tokens',async()=>{
    const run=createExportOperation({} as never)
    await expect(run({manifestPath:'x',previewReceiptId:'x',destinationPath:'relative.html'},exec())).rejects.toThrow('absolute path')
  })
  it('requires the same draft audit reporter as the tool',()=>{
    expect(()=>createDraftOperation({} as never)).toThrow('audit failure reporter')
  })
  it('rejects unexpected draft arguments before authority or approval',async()=>{
    const approval={request:vi.fn()};const run=createDraftOperation({approval,reportAuditFailure(){}} as never)
    await expect(run({manifestPath:'x',previewReceiptId:'x',planPaths:[],extra:true} as never,exec())).rejects.toThrow('unknown or missing arguments')
    expect(approval.request).not.toHaveBeenCalled()
  })
  it('honors cancellation before any draft or export work',async()=>{
    const abort=new AbortController();abort.abort();const context={...exec(),signal:abort.signal}
    await expect(createDraftOperation({reportAuditFailure(){}} as never)({manifestPath:'x',previewReceiptId:'x',planPaths:[]},context)).rejects.toThrow('cancelled')
    await expect(createExportOperation({} as never)({manifestPath:'x',previewReceiptId:'x',destinationPath:'/tmp/x'},context)).rejects.toThrow('cancelled')
  })
})
