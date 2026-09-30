//! Local fixture HTTP server for rights tests. No live provider is contacted.

use std::{
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

#[derive(Debug, Clone)]
pub enum Body {
    Bytes(Vec<u8>),
    /// Declares `declared` bytes but sends `sent` and closes (interrupted download).
    Truncated {
        declared: usize,
        sent: Vec<u8>,
    },
}

#[derive(Debug, Clone)]
pub struct Route {
    pub path: String,
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Body,
    pub chunked: bool,
}

impl Route {
    pub fn ok(path: &str, content_type: &str, body: Vec<u8>) -> Self {
        Self {
            path: path.into(),
            status: 200,
            headers: vec![("Content-Type".into(), content_type.into())],
            body: Body::Bytes(body),
            chunked: false,
        }
    }

    pub fn redirect(path: &str, location: &str) -> Self {
        Self {
            path: path.into(),
            status: 302,
            headers: vec![("Location".into(), location.into())],
            body: Body::Bytes(Vec::new()),
            chunked: false,
        }
    }

    pub fn status(path: &str, status: u16) -> Self {
        Self {
            path: path.into(),
            status,
            headers: vec![("Content-Type".into(), "text/plain".into())],
            body: Body::Bytes(Vec::new()),
            chunked: false,
        }
    }

    pub fn truncated(path: &str, content_type: &str, declared: usize, sent: Vec<u8>) -> Self {
        Self {
            path: path.into(),
            status: 200,
            headers: vec![("Content-Type".into(), content_type.into())],
            body: Body::Truncated { declared, sent },
            chunked: false,
        }
    }

    pub fn with_header(mut self, name: &str, value: &str) -> Self {
        self.headers.push((name.into(), value.into()));
        self
    }

    pub fn chunked(mut self) -> Self {
        self.chunked = true;
        self
    }
}

pub struct FixtureServer {
    base: String,
    routes: Arc<Mutex<Vec<Route>>>,
    hits: Arc<AtomicUsize>,
    requests: Arc<Mutex<Vec<String>>>,
}

impl FixtureServer {
    pub fn start(routes: Vec<Route>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind fixture server");
        let base = format!("http://{}", listener.local_addr().expect("addr"));
        let routes = Arc::new(Mutex::new(routes));
        let hits = Arc::new(AtomicUsize::new(0));
        let requests = Arc::new(Mutex::new(Vec::new()));
        let (thread_routes, thread_hits, thread_requests) =
            (routes.clone(), hits.clone(), requests.clone());
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(stream) = stream else { continue };
                let routes = thread_routes.clone();
                let hits = thread_hits.clone();
                let requests = thread_requests.clone();
                std::thread::spawn(move || serve(stream, &routes, &hits, &requests));
            }
        });
        Self {
            base,
            routes,
            hits,
            requests,
        }
    }

    pub fn url(&self, path: &str) -> String {
        format!("{}{path}", self.base)
    }

    pub fn base(&self) -> &str {
        &self.base
    }

    pub fn set_routes(&self, routes: Vec<Route>) {
        *self.routes.lock().expect("routes") = routes;
    }

    pub fn hits(&self) -> usize {
        self.hits.load(Ordering::SeqCst)
    }

    pub fn requests(&self) -> Vec<String> {
        self.requests.lock().expect("requests").clone()
    }
}

fn serve(
    mut stream: TcpStream,
    routes: &Mutex<Vec<Route>>,
    hits: &AtomicUsize,
    requests: &Mutex<Vec<String>>,
) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let mut raw = Vec::new();
    let mut buffer = [0u8; 4096];
    while !raw.windows(4).any(|w| w == b"\r\n\r\n") {
        match stream.read(&mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(n) => raw.extend_from_slice(&buffer[..n]),
        }
    }
    let text = String::from_utf8_lossy(&raw).to_string();
    hits.fetch_add(1, Ordering::SeqCst);
    requests.lock().expect("requests").push(text.clone());
    let target = text.split_whitespace().nth(1).unwrap_or("/").to_owned();
    let path = target.split('?').next().unwrap_or("/").to_owned();
    let route = routes
        .lock()
        .expect("routes")
        .iter()
        .find(|route| route.path == path || route.path == target)
        .cloned()
        .unwrap_or_else(|| Route::status(&path, 404));
    let mut head = format!("HTTP/1.1 {} X\r\nConnection: close\r\n", route.status);
    for (name, value) in &route.headers {
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    match &route.body {
        Body::Bytes(bytes) if route.chunked => {
            head.push_str("Transfer-Encoding: chunked\r\n\r\n");
            let _ = stream.write_all(head.as_bytes());
            for chunk in bytes.chunks(1024) {
                let _ = stream.write_all(format!("{:x}\r\n", chunk.len()).as_bytes());
                let _ = stream.write_all(chunk);
                let _ = stream.write_all(b"\r\n");
            }
            let _ = stream.write_all(b"0\r\n\r\n");
        }
        Body::Bytes(bytes) => {
            head.push_str(&format!("Content-Length: {}\r\n\r\n", bytes.len()));
            let _ = stream.write_all(head.as_bytes());
            let _ = stream.write_all(bytes);
        }
        Body::Truncated { declared, sent } => {
            head.push_str(&format!("Content-Length: {declared}\r\n\r\n"));
            let _ = stream.write_all(head.as_bytes());
            let _ = stream.write_all(sent);
        }
    }
    let _ = stream.flush();
    let _ = stream.shutdown(std::net::Shutdown::Both);
}
