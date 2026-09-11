import { redirect } from "@remix-run/node";

export const loader = ({ request }) => {
  const url = new URL(request.url);
  url.protocol = "https:";
  url.pathname = "/app";
  return redirect(url.toString());
};
