import { createGetDb } from "@agent-native/core/db";
import { registerShareableResource } from "@agent-native/core/sharing";

import * as schema from "./schema.js";

export const getDb = createGetDb(schema);
export { schema };

registerShareableResource({
  type: "hackathon",
  resourceTable: schema.hackathons,
  sharesTable: schema.hackathonShares,
  displayName: "Hackathon",
  titleColumn: "name",
  getResourcePath: (row: { id: string }) => `/hackathons/${row.id}`,
  getDb,
});
