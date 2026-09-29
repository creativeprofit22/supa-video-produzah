//! Scripted local HTTP server standing in for Anthropic endpoints in tests.

use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// Each request gets the next scripted response; the last one repeats.
pub struct FakeServer {
    pub url: String,
    hits: Arc<AtomicUsize>,
    requests: Arc<Mutex<Vec<String>>>,
}

impl FakeServer {
    pub fn hit_count(&self) -> usize {
        self.hits.load(Ordering::SeqCst)
    }

    pub fn request(&self, index: usize) -> String {
        self.requests.lock().expect("requests")[index].clone()
    }
}

pub fn spawn_fake_server(responses: Vec<(u16, String)>, delay: Duration) -> FakeServer {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
    let url = format!("http://{}/endpoint", listener.local_addr().expect("addr"));
    let hits = Arc::new(AtomicUsize::new(0));
    let requests = Arc::new(Mutex::new(Vec::new()));
    let (thread_hits, thread_requests) = (hits.clone(), requests.clone());
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            let raw = read_request(&mut stream);
            let index = thread_hits.fetch_add(1, Ordering::SeqCst);
            thread_requests
                .lock()
                .expect("requests")
                .push(String::from_utf8_lossy(&raw).to_string());
            std::thread::sleep(delay);
            let (status, body) = responses[index.min(responses.len() - 1)].clone();
            let reply = format!(
                "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = stream.write_all(reply.as_bytes());
        }
    });
    FakeServer {
        url,
        hits,
        requests,
    }
}

fn read_request(stream: &mut std::net::TcpStream) -> Vec<u8> {
    let mut raw = Vec::new();
    let mut buffer = [0u8; 4096];
    let mut expected_total = None;
    while let Ok(read) = stream.read(&mut buffer) {
        if read == 0 {
            break;
        }
        raw.extend_from_slice(&buffer[..read]);
        if expected_total.is_none() {
            let text = String::from_utf8_lossy(&raw).to_string();
            if let Some(header_end) = text.find("\r\n\r\n") {
                let length = text[..header_end]
                    .lines()
                    .find_map(|line| {
                        let (name, value) = line.split_once(':')?;
                        name.eq_ignore_ascii_case("content-length")
                            .then(|| value.trim().parse::<usize>().ok())
                            .flatten()
                    })
                    .unwrap_or(0);
                expected_total = Some(header_end + 4 + length);
            }
        }
        if expected_total.is_some_and(|total| raw.len() >= total) {
            break;
        }
    }
    raw
}

/// The JSON body of a captured raw HTTP request.
pub fn request_json(raw: &str) -> serde_json::Value {
    let body = raw.split_once("\r\n\r\n").map_or("", |(_, body)| body);
    serde_json::from_str(body).expect("request body is JSON")
}

/// The value of a header in a captured raw HTTP request (case-insensitive).
pub fn request_header(raw: &str, name: &str) -> Option<String> {
    let head = raw.split_once("\r\n\r\n").map_or(raw, |(head, _)| head);
    head.lines().find_map(|line| {
        let (key, value) = line.split_once(':')?;
        key.eq_ignore_ascii_case(name)
            .then(|| value.trim().to_owned())
    })
}
