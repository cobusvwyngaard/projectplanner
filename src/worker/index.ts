import { DurableObject } from "cloudflare:workers";

export class PlannerMcp extends DurableObject {}

export default {
  fetch(): Response {
    return new Response("Not ready", { status: 503 });
  },
} satisfies ExportedHandler<Env>;
