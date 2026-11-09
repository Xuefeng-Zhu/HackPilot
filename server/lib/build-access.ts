import { getRequestContext } from "@agent-native/core/server";
import { and, eq, isNotNull, isNull, or } from "drizzle-orm";

import { schema } from "../db/index.js";

export function getBuildAuthUserId() {
  const context = getRequestContext();
  if (
    !context?.userEmail || context.agentRunAnonymous || context.authCapability ||
    context.credentialScope === "org" || context.verifiedServiceIdentity
  ) {
    return undefined;
  }
  return context.authUserId;
}

/** Apply in addition to checking access to the build's parent hackathon. */
export function buildAccessFilter(authUserId: string | null | undefined) {
  const { designPrototypeId, designOwnerAuthId, orgId } = schema.builds;
  const regularBuild = and(isNull(designPrototypeId), isNull(designOwnerAuthId));
  if (!authUserId) return regularBuild;
  return or(
    regularBuild,
    and(
      isNotNull(designPrototypeId),
      eq(designOwnerAuthId, authUserId),
      isNull(orgId),
    ),
  );
}
