/**
 * Per-request authority for decisions the model must not grant itself. Preferences from older
 * messages stay in history, but expensive choices need a basis in the current request.
 */
export interface RequestPolicy {
  requestId: string;
  projectId: string;
  message: string;
  allowFinalImage: boolean;
}

export function explicitFinalImageRequest(message: string) {
  return /(?:финал|качеств|продакшн|production|\b2k\b|высок\w*\s+качеств|улучши|доработай)/i.test(message);
}

export class AgentPolicy {
  private current: RequestPolicy | null = null;

  begin(requestId: string, projectId: string, message: string) {
    this.current = { requestId, projectId, message, allowFinalImage: explicitFinalImageRequest(message) };
  }

  clear(requestId?: string) {
    if (!requestId || this.current?.requestId === requestId) this.current = null;
  }

  allowsFinalImage(projectId: string) {
    // Outside a Studio chat request the direct/panel path is responsible for the choice.
    if (!this.current) return true;
    return this.current.projectId === projectId && this.current.allowFinalImage;
  }
}
