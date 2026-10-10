import type { ConfirmRequest } from '@/components/ui/ConfirmDialog'
import type { PromptRequest } from '@/components/ui/PromptDialog'
import type { Manage, ManageView } from '@/lib/manage'

/** What every part of "Manage host" is given: the host, and ways to ask. */
export interface Tools {
  m: Manage
  view: ManageView
  confirm: (request: ConfirmRequest) => Promise<boolean>
  prompt: (request: PromptRequest) => void
  /** This device no longer manages the host: the screen closes. */
  leave: () => void
}
