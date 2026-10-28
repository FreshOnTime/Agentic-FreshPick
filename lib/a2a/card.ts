import { AgentCard } from '@a2a-js/sdk';
import { a2aOrigin } from './config';

export function quotationAgentCard(): AgentCard {
  const origin = a2aOrigin();
  return AgentCard.fromJSON({
    name: 'FreshPick quotation agent',
    description: 'Prepare non-binding LKR grocery quotations from exact catalog product IDs and whole-pack quantities. No purchasing, stock reservation, refunds or supplier messages.',
    version: '1.0.0',
    supportedInterfaces: [{ url: `${origin}/api/a2a`, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
    provider: { organization: 'FreshPick', url: origin },
    documentationUrl: 'https://FreshOnTime.github.io/Agentic-FreshPick/A2A.html',
    capabilities: { streaming: false, pushNotifications: false, extendedAgentCard: false },
    securitySchemes: { partnerToken: { httpAuthSecurityScheme: { scheme: 'bearer', description: 'A separate high-entropy token per approved partner; provisioned out of band.' } } },
    securityRequirements: [{ schemes: { partnerToken: { list: [] } } }],
    defaultInputModes: ['application/json', 'text/plain'],
    defaultOutputModes: ['application/json', 'text/plain'],
    skills: [{ id: 'prepare_quote', name: 'Prepare a grocery quotation',
      description: 'Send a data part with skill=prepare_quote, name, budget in LKR, items [{productId, quantity}], and delivery {city,country}. Text-only or incomplete requests receive structured input requirements. Quotes expire after 30 minutes and require fresh checkout validation. Delivery dates are not promised.',
      tags: ['groceries', 'quotation', 'b2b'], examples: ['Prepare a produce quotation within LKR 5,000 for delivery to Colombo.'] }],
  });
}
