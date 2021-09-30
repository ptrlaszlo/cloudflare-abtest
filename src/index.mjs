// Worker

export default {
  async fetch(request, env) {
    return await handleRequest(request, env);
  }
}

const BASE_PATH = '/abtest'
const CONTROL_PATH = `${BASE_PATH}/control`;
const VARIANT_PATH = `${BASE_PATH}/variant`;
const ACTION_PATH = `${BASE_PATH}/action`;
const RESULT_PATH = `${BASE_PATH}/result`;

const COUNTER_CONTROL_SHOW = 'control-show';
const COUNTER_CONTROL_ACTION = 'control-action';
const COUNTER_VARIANT_SHOW = 'variant-show';
const COUNTER_VARIANT_ACTION = 'variant-action';

async function handleRequest(request, env) {

  let url = new URL(request.url);

  switch (url.pathname) {

    // The control path checks if the user was already assigned to the control or the variant group
    // and shows the correct page based on that
    // If the A/B test cookie is not present, then we are dealing with a new user
    // We assigned the user to a group randomly and count their visit
    case BASE_PATH:
      if (hasControlCookie(request)) {
        url.pathname = CONTROL_PATH;
        return await fetch(request);
      } else if (hasVariantCookie(request)) {
        url.pathname = VARIANT_PATH;
        return await fetch(url, request);
      } else {
        const group = Math.random() < 0.5 ? "variant" : "control"

        // We are only counting the page visits here, to prevent double counting page refreshes
        if (group === "variant") {
          url.pathname = VARIANT_PATH;
          incrementCounter(COUNTER_VARIANT_SHOW, env);
        } else {
          url.pathname = CONTROL_PATH;
          incrementCounter(COUNTER_CONTROL_SHOW, env);
        }
        const response = await fetch(url, request);
        return setAbTestCookie(response, group);
      }
      break;

    // The action path is the user action we are tracking
    // We check which group is the user part of and increment the counters based on that
    // We also set a cookie to prevent double counting the user actions
    case ACTION_PATH:
      let response = Response.redirect("https://ptrlaszlo.com/posts/cloudflare-ab-testing", 302)

      if (hasControlCookie(request) && actionNotCountedCookie(request)) {
        await incrementCounter(COUNTER_CONTROL_ACTION, env);
        response = setActionCountedCookie(response);

      } else if (hasVariantCookie(request) && actionNotCountedCookie(request)) {
        await incrementCounter(COUNTER_VARIANT_ACTION, env);
        response = setActionCountedCookie(response);

      }
      return response;
      break;

    // The result path return the counter values
    case RESULT_PATH:
      let counterControlShow = await getCounterValue(COUNTER_CONTROL_SHOW, env);
      let counterControlAction = await getCounterValue(COUNTER_CONTROL_ACTION, env);
      let counterVariantShow = await getCounterValue(COUNTER_VARIANT_SHOW, env);
      let counterVariantAction = await getCounterValue(COUNTER_VARIANT_ACTION, env);

      const data = {
        controlShow: counterControlShow,
        controlAction: counterControlAction,
        variantShow: counterVariantShow,
        variantAction: counterVariantAction
      }

      return new Response(JSON.stringify(data, null, 2), {
          headers: {
            "content-type": "application/json;charset=UTF-8"
          }
        });
      break;

    // For every other path, we proxy the request without further action
    default:
      return await fetch(request);
  }

}

// Helper methods for durable object counters
async function incrementCounter(key, env) {
  let id = env.COUNTER.idFromName(key);
  let obj = env.COUNTER.get(id);
  let resp = await obj.fetch("increment");
  return await resp.text();
}

async function getCounterValue(key, env) {
  let id = env.COUNTER.idFromName(key);
  let obj = env.COUNTER.get(id);
  let resp = await obj.fetch("value");
  return await resp.text();
}


const COOKIE_NAME = "cloudflare_ab_test";

// Helper methods for checking and changing cookie values
function hasControlCookie(request) {
  let cookie = request.headers.get("cookie");
  return cookie && cookie.includes(`${COOKIE_NAME}=control`);
}

function hasVariantCookie(request) {
  let cookie = request.headers.get("cookie");
  return cookie && cookie.includes(`${COOKIE_NAME}=variant`);
}

function setAbTestCookie(response, value) {
  // Clone the response so we can update the headers
  const newResponse = new Response(response.body, response);
  newResponse.headers.append("Set-Cookie", `${COOKIE_NAME}=${value}; path=/`);
  return newResponse;
}

function actionNotCountedCookie(request) {
  let cookie = request.headers.get("cookie");
  return cookie && !cookie.includes(`cloudflare_ab_test_counted=true`);
}

function setActionCountedCookie(response) {
  // Clone the response so we can update the headers
  const newResponse = new Response(response.body, response);
  newResponse.headers.append("Set-Cookie", `cloudflare_ab_test_counted=true; path=/`);
  return newResponse;
}


// Durable Object implementing a counter for page visits and user actions

export class Counter {
  constructor(state, env) {
    this.state = state;
    // `blockConcurrencyWhile()` ensures no requests are delivered until
    // initialization completes.
    this.state.blockConcurrencyWhile(async () => {
        let stored = await this.state.storage.get("value");
        this.value = stored || 0;
    })
  }

  // Handle HTTP requests from clients.
  async fetch(request) {
    // Apply requested action.
    let url = new URL(request.url);
    let currentValue = this.value;
    switch (url.pathname) {
    case "/increment":
      currentValue = ++this.value;
      await this.state.storage.put("value", this.value);
      break;
    case "/decrement":
      currentValue = --this.value;
      await this.state.storage.put("value", this.value);
      break;
    case "/value":
      // Just serve the current value. No storage calls needed!
      break;
    default:
      return new Response("Not found " + url.pathname, {status: 404});
    }

    // Return `currentValue`. Note that `this.value` may have been
    // incremented or decremented by a concurrent request when we
    // yielded the event loop to `await` the `storage.put` above!
    // That's why we stored the counter value created by this
    // request in `currentValue` before we used `await`.
    return new Response(currentValue);
  }
}
