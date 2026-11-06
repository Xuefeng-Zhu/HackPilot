import { Outlet } from "react-router";

export function meta() {
  return [{ title: "HackPilot — hackathons" }];
}

export function HydrateFallback() {
  return (
    <div className="flex h-full items-center justify-center">
      <div className="size-8 animate-spin rounded-full border-b-2 border-foreground" />
    </div>
  );
}

export default function HackathonsLayout() {
  return <Outlet />;
}
