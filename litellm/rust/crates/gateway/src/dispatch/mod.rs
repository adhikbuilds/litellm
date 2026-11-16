mod config;

use std::sync::Arc;

use crate::Gateway;
use axum::{
    Router,
    body::HttpBody,
    extract::{Request, State},
    middleware::{self, Next},
    response::Response,
};
use litellm_config::Config;
use litellm_gateway_auth::{ApiKey, Auth, Error};
use litellm_gateway_auth_core::{
    RouteGroups, Token,
    plan::{self, Plan},
};
use litellm_gateway_forward::Forward;

#[derive(Clone)]
struct Gate {
    auth: Auth,
    plans: plan::Settings,
    forward: Forward,
}

impl Gate {
    /// Whether the proxy authenticates `key` on `route` as a key, the one path the gateway serves.
    fn plans_key(&self, route: &str, key: &ApiKey) -> bool {
        let token = Token::new(key.0.clone());
        let request = plan::Request {
            route,
            token: Some(&token),
            is_llm_api_route: true,
            ..plan::Request::default()
        };
        plan::plan(&request, &self.plans) == Ok(Plan::Key)
    }
}

/// How the proxy picks a request's authentication path. The gateway can't check a license, so
/// every path that needs one errors and forwards, and it has no route groups, which list no
/// inference route.
fn plans(config: &Config) -> plan::Settings {
    plan::Settings::new(
        &config.general_settings,
        false,
        false,
        &RouteGroups::default(),
    )
}

/// Serves a request natively only when it has no body, the proxy would authenticate its key as a
/// key, and that key is the master key. Every other request goes to Python, which answers it as it would without the
/// gateway. This only authenticates. What the caller may do is still each handler's check.
async fn gate(
    State(gate): State<Gate>,
    key: Result<ApiKey, Error>,
    request: Request,
    next: Next,
) -> Response {
    let (mut parts, body) = request.into_parts();
    let identity = match key {
        // TODO: no body is on the allowlist until the gateway runs `is_request_body_safe` and knows
        // which body fields mean something to Python alone
        _ if !body.is_end_stream() => Err(Error::Unsupported),
        Ok(key) if gate.plans_key(parts.uri.path(), &key) => {
            gate.auth.authenticate_request(&key.into(), &parts).await
        }
        Ok(_) => Err(Error::Unsupported),
        Err(error) => Err(error),
    };
    match identity {
        Ok(identity) => {
            parts.extensions.insert(identity);
            next.run(Request::from_parts(parts, body)).await
        }
        Err(error) => {
            if !error.is_denied() {
                tracing::debug!(
                    error = %litellm_error::Report::new(&error),
                    "gateway authentication failed, so python authenticates the request"
                );
            }
            gate.forward.relay(Request::from_parts(parts, body)).await
        }
    }
}

/// The inference routes in front of Python. The gateway serves a request only when the
/// configuration, the route and the request are all ones it is known to handle the way Python
/// does, and Python serves the rest through `forward`.
pub fn dispatching_router(
    inference: Result<Arc<Gateway>, crate::Error>,
    config: &Config,
    env: &dyn Fn(&str) -> Option<String>,
    forward: Forward,
) -> Router {
    if let Err(unsupported) = config::supported(config, env) {
        tracing::info!(
            reason = %unsupported,
            "the configuration is off the gateway's allowlist, so python serves every request"
        );
        return Router::new().fallback_service(forward);
    }
    let inference = match inference {
        Ok(inference) => inference,
        Err(unserved) => {
            tracing::info!(
                reason = %litellm_error::Report::new(&unserved),
                "the gateway can't serve this configuration natively, so python serves every request"
            );
            return Router::new().fallback_service(forward);
        }
    };
    let gate_state = Gate {
        plans: plans(config),
        auth: Auth::from_config(config, inference.secrets.clone()),
        forward: forward.clone(),
    };
    let wrong_method = forward.clone();
    litellm_gateway_inference::router(inference)
        .layer(middleware::from_fn(crate::log_request))
        .route_layer(middleware::from_fn_with_state(gate_state, gate))
        .method_not_allowed_fallback(move |request: Request| wrong_method.relay(request))
        .fallback_service(forward)
}
