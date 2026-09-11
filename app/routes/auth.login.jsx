import { login } from "../shopify.server";

export async function loader({ request }) {
  return login(request);
}

export async function action({ request }) {
  return login(request);
}
