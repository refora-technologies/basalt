//! Reading and writing the request/response envelope over an async stream.
//!
//! Every byte the host and client exchange passes through these four
//! functions, so they are deliberately dull: fixed-size headers, explicit
//! bounds, no allocation until a length has been checked.

use basalt_proto::ops::{MAX_REQUEST_BYTES, Op, STATUS_ERR, STATUS_OK};
use basalt_proto::{ErrorCode, WireError};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

use crate::{NetError, Result};

/// Ceiling on a response payload held in memory at once.
///
/// Bulk file bodies are streamed, not buffered, so nothing legitimate
/// approaches this. It exists so a corrupt or hostile length field cannot ask
/// the client to allocate a terabyte.
pub const MAX_BUFFERED_RESPONSE: u64 = 256 * 1024 * 1024;

pub async fn write_request<W>(w: &mut W, op: Op, payload: &[u8]) -> Result<()>
where
    W: AsyncWrite + Unpin + ?Sized,
{
    if payload.len() as u64 > MAX_REQUEST_BYTES as u64 {
        return Err(NetError::Protocol(format!(
            "request payload of {} bytes exceeds the {MAX_REQUEST_BYTES} byte limit",
            payload.len()
        )));
    }
    let mut head = [0u8; 5];
    head[0] = op as u8;
    head[1..5].copy_from_slice(&(payload.len() as u32).to_le_bytes());
    w.write_all(&head).await?;
    if !payload.is_empty() {
        w.write_all(payload).await?;
    }
    w.flush().await?;
    Ok(())
}

pub async fn read_request<R>(r: &mut R) -> Result<(Op, Vec<u8>)>
where
    R: AsyncRead + Unpin + ?Sized,
{
    let (op, payload) = read_request_raw(r).await?;
    Ok((Op::from_u8(op)?, payload))
}

/// A request whose operation may be one this build does not know.
///
/// The payload is read either way, so the connection stays in step and the
/// caller can answer "unsupported" instead of hanging up. Hanging up is what
/// older hosts did, and a newer device saw it as the host going offline.
pub async fn read_request_raw<R>(r: &mut R) -> Result<(u8, Vec<u8>)>
where
    R: AsyncRead + Unpin + ?Sized,
{
    read_request_limited(r, MAX_REQUEST_BYTES).await
}

/// As [`read_request_raw`], refusing a request declared larger than `limit`.
///
/// The payload grows as its bytes arrive, rather than being set aside in full
/// when the size is read: a peer that declares 64 MB and then sends nothing
/// would otherwise hold 64 MB of the host's memory for each connection it
/// opened, and a few hundred of them, from anyone on the network, ran the
/// host out of memory.
pub async fn read_request_limited<R>(r: &mut R, limit: u32) -> Result<(u8, Vec<u8>)>
where
    R: AsyncRead + Unpin + ?Sized,
{
    let mut head = [0u8; 5];
    r.read_exact(&mut head).await?;
    let op = head[0];
    let len = u32::from_le_bytes([head[1], head[2], head[3], head[4]]);
    let limit = limit.min(MAX_REQUEST_BYTES);
    if len > limit {
        return Err(NetError::Protocol(format!(
            "request declares {len} bytes, over the {limit} byte limit"
        )));
    }
    let mut payload = Vec::with_capacity((len as usize).min(64 * 1024));
    (&mut *r)
        .take(u64::from(len))
        .read_to_end(&mut payload)
        .await?;
    if payload.len() != len as usize {
        return Err(NetError::Io(std::io::Error::new(
            std::io::ErrorKind::UnexpectedEof,
            "the request ended early",
        )));
    }
    Ok((op, payload))
}

pub async fn write_response_header<W>(w: &mut W, status: u8, len: u64) -> Result<()>
where
    W: AsyncWrite + Unpin + ?Sized,
{
    let mut head = [0u8; 9];
    head[0] = status;
    head[1..9].copy_from_slice(&len.to_le_bytes());
    w.write_all(&head).await?;
    Ok(())
}

pub async fn read_response_header<R>(r: &mut R) -> Result<(u8, u64)>
where
    R: AsyncRead + Unpin + ?Sized,
{
    let mut head = [0u8; 9];
    r.read_exact(&mut head).await?;
    Ok((
        head[0],
        u64::from_le_bytes(head[1..9].try_into().expect("slice is 8 bytes")),
    ))
}

/// Writes a complete successful response.
pub async fn write_ok<W>(w: &mut W, payload: &[u8]) -> Result<()>
where
    W: AsyncWrite + Unpin + ?Sized,
{
    write_response_header(w, STATUS_OK, payload.len() as u64).await?;
    w.write_all(payload).await?;
    w.flush().await?;
    Ok(())
}

/// Writes a complete error response.
pub async fn write_err<W>(w: &mut W, code: ErrorCode, message: &str) -> Result<()>
where
    W: AsyncWrite + Unpin + ?Sized,
{
    let body = serde_json::to_vec(&WireError::new(code, message))
        .unwrap_or_else(|_| br#"{"code":"io","message":"unserialisable error"}"#.to_vec());
    write_response_header(w, STATUS_ERR, body.len() as u64).await?;
    w.write_all(&body).await?;
    w.flush().await?;
    Ok(())
}

/// Reads a whole response into memory, turning an error status into an error.
pub async fn read_response<R>(r: &mut R) -> Result<Vec<u8>>
where
    R: AsyncRead + Unpin + ?Sized,
{
    let (status, len) = read_response_header(r).await?;
    if len > MAX_BUFFERED_RESPONSE {
        return Err(NetError::Protocol(format!(
            "response declares {len} bytes, over the {MAX_BUFFERED_RESPONSE} byte limit"
        )));
    }
    let mut body = vec![0u8; len as usize];
    r.read_exact(&mut body).await?;

    if status == STATUS_OK {
        return Ok(body);
    }
    // An error body that does not parse is still an error — fall back to
    // whatever text arrived rather than reporting a parse failure and losing
    // the real reason.
    Err(match serde_json::from_slice::<WireError>(&body) {
        Ok(e) => NetError::Remote(e),
        Err(_) => NetError::Remote(WireError::new(
            ErrorCode::Io,
            String::from_utf8_lossy(&body).into_owned(),
        )),
    })
}

/// Reads a JSON response body and deserialises it.
pub async fn read_json<R, T>(r: &mut R) -> Result<T>
where
    R: AsyncRead + Unpin + ?Sized,
    T: serde::de::DeserializeOwned,
{
    let body = read_response(r).await?;
    serde_json::from_slice(&body)
        .map_err(|e| NetError::Protocol(format!("response body did not parse: {e}")))
}

/// Sends a JSON request and reads a JSON response.
pub async fn call_json<S, Req, Resp>(stream: &mut S, op: Op, request: &Req) -> Result<Resp>
where
    S: AsyncRead + AsyncWrite + Unpin + ?Sized,
    Req: serde::Serialize,
    Resp: serde::de::DeserializeOwned,
{
    let body = serde_json::to_vec(request)
        .map_err(|e| NetError::Protocol(format!("could not encode {op:?}: {e}")))?;
    write_request(stream, op, &body).await?;
    read_json(stream).await
}

/// Sends a JSON request and discards a successful empty response.
pub async fn call_unit<S, Req>(stream: &mut S, op: Op, request: &Req) -> Result<()>
where
    S: AsyncRead + AsyncWrite + Unpin + ?Sized,
    Req: serde::Serialize,
{
    let body = serde_json::to_vec(request)
        .map_err(|e| NetError::Protocol(format!("could not encode {op:?}: {e}")))?;
    write_request(stream, op, &body).await?;
    read_response(stream).await.map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;
    use basalt_proto::msg::ListRequest;

    fn header(op: u8, len: u32) -> Vec<u8> {
        let mut head = vec![op];
        head.extend_from_slice(&len.to_le_bytes());
        head
    }

    #[tokio::test]
    async fn a_request_over_the_limit_is_refused_before_its_bytes() {
        let bytes = header(Op::Hello as u8, 300 * 1024);
        let refused = read_request_limited(&mut bytes.as_slice(), 256 * 1024).await;
        assert!(matches!(refused, Err(NetError::Protocol(_))), "{refused:?}");
    }

    // The attack this guards: a header claiming 64 MB and nothing after it,
    // from many connections at once. The payload grows with what arrives, so
    // a request that stops short costs only what it sent, and is an error.
    #[tokio::test]
    async fn a_request_that_stops_short_is_an_error() {
        let mut bytes = header(Op::Hello as u8, 64 * 1024 * 1024);
        bytes.extend_from_slice(b"only this much");
        let read = read_request_raw(&mut bytes.as_slice()).await;
        assert!(matches!(read, Err(NetError::Io(_))), "{read:?}");
    }

    #[tokio::test]
    async fn a_request_within_the_limit_is_read_whole() {
        let mut bytes = header(Op::Ping as u8, 5);
        bytes.extend_from_slice(b"hello");
        let (op, payload) = read_request_limited(&mut bytes.as_slice(), 16)
            .await
            .unwrap();
        assert_eq!(op, Op::Ping as u8);
        assert_eq!(payload, b"hello");
    }

    #[tokio::test]
    async fn a_request_round_trips() {
        let (mut a, mut b) = tokio::io::duplex(4096);
        write_request(&mut a, Op::List, b"photos/2024")
            .await
            .unwrap();
        let (op, payload) = read_request(&mut b).await.unwrap();
        assert_eq!(op, Op::List);
        assert_eq!(payload, b"photos/2024");
    }

    #[tokio::test]
    async fn an_empty_request_round_trips() {
        let (mut a, mut b) = tokio::io::duplex(64);
        write_request(&mut a, Op::Ping, b"").await.unwrap();
        let (op, payload) = read_request(&mut b).await.unwrap();
        assert_eq!(op, Op::Ping);
        assert!(payload.is_empty());
    }

    #[tokio::test]
    async fn an_ok_response_round_trips() {
        let (mut a, mut b) = tokio::io::duplex(4096);
        write_ok(&mut a, b"body").await.unwrap();
        assert_eq!(read_response(&mut b).await.unwrap(), b"body");
    }

    #[tokio::test]
    async fn an_error_response_arrives_as_an_error_with_its_code_intact() {
        let (mut a, mut b) = tokio::io::duplex(4096);
        write_err(&mut a, ErrorCode::NotFound, "no such file")
            .await
            .unwrap();
        match read_response(&mut b).await {
            Err(NetError::Remote(e)) => {
                assert_eq!(e.code, ErrorCode::NotFound);
                assert_eq!(e.message, "no such file");
            }
            other => panic!("expected a remote error, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn an_unparseable_error_body_still_reports_an_error() {
        let (mut a, mut b) = tokio::io::duplex(4096);
        write_response_header(&mut a, STATUS_ERR, 5).await.unwrap();
        a.write_all(b"boom!").await.unwrap();
        a.flush().await.unwrap();
        match read_response(&mut b).await {
            Err(NetError::Remote(e)) => assert_eq!(e.message, "boom!"),
            other => panic!("expected a remote error, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn an_oversized_response_is_refused_before_allocating() {
        let (mut a, mut b) = tokio::io::duplex(64);
        write_response_header(&mut a, STATUS_OK, u64::MAX)
            .await
            .unwrap();
        a.flush().await.unwrap();
        assert!(matches!(
            read_response(&mut b).await,
            Err(NetError::Protocol(_))
        ));
    }

    #[tokio::test]
    async fn an_unknown_opcode_is_rejected_rather_than_misread() {
        let (mut a, mut b) = tokio::io::duplex(64);
        a.write_all(&[200u8, 0, 0, 0, 0]).await.unwrap();
        a.flush().await.unwrap();
        assert!(read_request(&mut b).await.is_err());
    }

    #[tokio::test]
    async fn an_oversized_request_length_is_refused_before_allocating() {
        let (mut a, mut b) = tokio::io::duplex(64);
        let mut head = [0u8; 5];
        head[0] = Op::List as u8;
        head[1..5].copy_from_slice(&u32::MAX.to_le_bytes());
        a.write_all(&head).await.unwrap();
        a.flush().await.unwrap();
        assert!(matches!(
            read_request(&mut b).await,
            Err(NetError::Protocol(_))
        ));
    }

    #[tokio::test]
    async fn json_calls_round_trip_both_ways() {
        let (mut client, mut server) = tokio::io::duplex(4096);

        let server_task = tokio::spawn(async move {
            let (op, payload) = read_request(&mut server).await.unwrap();
            assert_eq!(op, Op::List);
            let req: ListRequest = serde_json::from_slice(&payload).unwrap();
            assert_eq!(req.path, "films");
            write_ok(&mut server, br#"{"entries":[]}"#).await.unwrap();
        });

        let resp: basalt_proto::msg::ListResponse = call_json(
            &mut client,
            Op::List,
            &ListRequest {
                path: "films".into(),
            },
        )
        .await
        .unwrap();
        assert!(resp.entries.is_empty());
        server_task.await.unwrap();
    }
}
