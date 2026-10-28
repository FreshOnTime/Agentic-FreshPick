import type { A2ARequestHandler } from '@a2a-js/sdk/server';
import { UnsupportedOperationError } from '@a2a-js/sdk/errors';
import { quotationAgentCard } from './card';
import { sendPartnerMessage, getPartnerTask, listPartnerTasks, cancelPartnerTask } from './service';

export function quotationHandler(partnerId: string): A2ARequestHandler {
  const unsupported = async (): Promise<never> => { throw new UnsupportedOperationError(); };
  const streamUnsupported = async function* (): AsyncGenerator<never> { throw new UnsupportedOperationError(); };
  return {
    getAgentCard: async () => quotationAgentCard(), getAuthenticatedExtendedAgentCard: unsupported,
    sendMessage: params => sendPartnerMessage(partnerId, params),
    getTask: params => getPartnerTask(partnerId, params.id, params.historyLength),
    listTasks: params => listPartnerTasks(partnerId, params),
    cancelTask: params => cancelPartnerTask(partnerId, params.id),
    sendMessageStream: streamUnsupported, resubscribe: streamUnsupported,
    createTaskPushNotificationConfig: unsupported, getTaskPushNotificationConfig: unsupported,
    listTaskPushNotificationConfigs: unsupported, deleteTaskPushNotificationConfig: unsupported,
  };
}
