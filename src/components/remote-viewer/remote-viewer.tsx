// The remote viewer: a live picture of the headless Facebook page running on the faceslop server
// (frames over SSE, drawn on a canvas) plus pointer, wheel and keyboard input sent back through the
// remoteInput server function. Protocol: src/shared/remote-view.ts. Pure input mapping:
// src/lib/remote-input.ts (unit tested).
//
// Both the stream and the input belong to this browser's session (its cookie). The viewer mounts
// only once the open request answered (which set the cookie), so the stream finds the session;
// a stream without one reports "closed" and asks EventSource to reconnect.
//
// Input can be the user's Facebook password. Nothing here logs events or keeps typed text.
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight, RotateCw } from 'lucide-react';
import {
  useEffect,
  useId,
  useRef,
  useState,
  type ClipboardEvent,
  type CompositionEvent,
  type InputEvent,
  type KeyboardEvent,
  type PointerEvent,
} from 'react';
import { InputSender } from '@/components/remote-viewer/input-sender';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { useRemoteStream, type StreamStatus } from '@/hooks/use-remote-stream';
import { queryKeys } from '@/lib/queries';
import {
  TAP_SLOP_PX,
  decideKey,
  mouseButtonOf,
  nextClickState,
  swipeToWheel,
  textEvents,
  toRemotePoint,
  wheelPixels,
  type ClickState,
  type Point,
} from '@/lib/remote-input';
import { cn } from '@/lib/utils';
import { remoteInput } from '@/server/functions/remote-view';
import { toClientError } from '@/shared/errors';
import {
  CLOSED_REMOTE_VIEW_STATE,
  type MouseButton,
  type RemoteFrame,
  type RemoteInputEvent,
  type RemoteViewState,
} from '@/shared/remote-view';

interface RemoteViewerProps {
  /** The open view's state (from the remote-view query; the stream keeps it current). */
  readonly state: RemoteViewState;
  readonly onDone: () => void;
  readonly closing?: boolean;
  readonly doneLabel?: string;
  /** Inside a dialog the picture leaves room for the dialog's own header. */
  readonly inDialog?: boolean;
}

interface ActivePointer {
  readonly id: number;
  readonly button: MouseButton;
  readonly clickCount: number;
  /** Touch: a tap clicks, a swipe scrolls the remote page. */
  readonly touch: { readonly start: Point; readonly startRemote: Point; last: Point; swiping: boolean } | null;
}

/** Pointer moves with a button held (drags): about 30 a second. Hover moves: about 10. */
const DRAG_MOVE_MS = 33;
const HOVER_MOVE_MS = 100;

const NO_MODIFIERS = { alt: false, ctrl: false, meta: false, shift: false } as const;
const press = (key: string): RemoteInputEvent => ({ _tag: 'key', action: 'press', key, modifiers: NO_MODIFIERS });

function viewStateOf(event: RemoteViewState & { readonly _tag: 'state' }): RemoteViewState {
  const { _tag: _ignored, ...state } = event;
  return state;
}

function shortUrl(url: string | null): string {
  if (url === null) return '';
  try {
    const parsed = new URL(url);
    return `${parsed.hostname.replace(/^www\./, '')}${parsed.pathname === '/' ? '' : parsed.pathname}`;
  } catch {
    return '';
  }
}

const STATUS_TEXT: Record<StreamStatus, string> = {
  connecting: 'Connecting…',
  live: '',
  reconnecting: 'Reconnecting…',
};

export function RemoteViewer({ state, onDone, closing = false, doneLabel = 'Done', inDialog = false }: RemoteViewerProps) {
  const queryClient = useQueryClient();
  const instructionsId = useId();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const keyboardRef = useRef<HTMLTextAreaElement | null>(null);
  const doneRef = useRef<HTMLButtonElement | null>(null);
  const pointerRef = useRef<ActivePointer | null>(null);
  const lastClickRef = useRef<ClickState | null>(null);
  const frameSeqRef = useRef({ received: 0, drawn: 0 });
  const [hasFrame, setHasFrame] = useState(false);
  const [inputProblem, setInputProblem] = useState<string | null>(null);
  const [sender] = useState(
    () =>
      new InputSender(
        (event) => remoteInput({ data: event }),
        (error) => {
          setInputProblem(toClientError(error).message);
        },
        () => {
          setInputProblem(null);
        },
      ),
  );

  // The sender lives as long as the viewer is mounted.
  useEffect(() => {
    sender.start();
    return () => {
      sender.dispose();
    };
  }, [sender]);

  const drawFrame = (frame: RemoteFrame) => {
    frameSeqRef.current.received += 1;
    const seq = frameSeqRef.current.received;
    const bytes = Uint8Array.from(atob(frame.data), (c) => c.charCodeAt(0));
    createImageBitmap(new Blob([bytes], { type: 'image/jpeg' })).then(
      (bitmap) => {
        const canvas = canvasRef.current;
        // Decoding is async: never let an older frame overwrite a newer one.
        if (canvas === null || seq < frameSeqRef.current.drawn) {
          bitmap.close();
          return;
        }
        frameSeqRef.current.drawn = seq;
        if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
        }
        canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
        bitmap.close();
        setHasFrame(true);
      },
      () => undefined,
    );
  };

  const status = useRemoteStream(
    (event) => {
      switch (event._tag) {
        case 'frame':
          drawFrame(event);
          break;
        case 'state':
          queryClient.setQueryData<RemoteViewState>(queryKeys.remoteView, viewStateOf(event));
          break;
        case 'closed':
          queryClient.setQueryData<RemoteViewState>(queryKeys.remoteView, CLOSED_REMOTE_VIEW_STATE);
          break;
      }
    },
    () => {
      // Refused (locked, or the view is gone): re-check; a closed view unmounts this viewer.
      void queryClient.invalidateQueries({ queryKey: queryKeys.remoteView });
    },
  );

  // ---------- pointer ----------

  const remotePoint = (client: Point, clampToEdge: boolean): Point | null => {
    const canvas = canvasRef.current;
    if (canvas === null) return null;
    return toRemotePoint(
      client,
      canvas.getBoundingClientRect(),
      { width: canvas.width, height: canvas.height },
      { width: state.width, height: state.height },
      clampToEdge,
    );
  };

  const focusKeyboard = () => {
    keyboardRef.current?.focus({ preventScroll: true });
  };

  const click = (point: Point, button: MouseButton, time: number) => {
    const next = nextClickState(lastClickRef.current, time, point, button);
    lastClickRef.current = next;
    return next.count;
  };

  const onPointerDown = (e: PointerEvent<HTMLCanvasElement>) => {
    const button = mouseButtonOf(e.button);
    const client = { x: e.clientX, y: e.clientY };
    const point = remotePoint(client, false);
    if (button === null || point === null) return;
    e.preventDefault();
    focusKeyboard();
    e.currentTarget.setPointerCapture(e.pointerId);
    if (e.pointerType === 'touch') {
      pointerRef.current = { id: e.pointerId, button, clickCount: 1, touch: { start: client, startRemote: point, last: client, swiping: false } };
      return;
    }
    const clickCount = click(point, button, e.timeStamp);
    pointerRef.current = { id: e.pointerId, button, clickCount, touch: null };
    sender.cancelMove();
    sender.send({ _tag: 'mouse', action: 'down', ...point, button, clickCount });
  };

  const onPointerMove = (e: PointerEvent<HTMLCanvasElement>) => {
    const active = pointerRef.current;
    const client = { x: e.clientX, y: e.clientY };
    if (active?.touch) {
      const { touch } = active;
      if (!touch.swiping && Math.hypot(client.x - touch.start.x, client.y - touch.start.y) > TAP_SLOP_PX) touch.swiping = true;
      if (touch.swiping) {
        const canvas = e.currentTarget;
        const rect = canvas.getBoundingClientRect();
        const delta = swipeToWheel(
          { x: client.x - touch.last.x, y: client.y - touch.last.y },
          rect,
          { width: canvas.width, height: canvas.height },
          { width: state.width, height: state.height },
        );
        sender.wheel(touch.startRemote.x, touch.startRemote.y, delta.x, delta.y);
      }
      touch.last = client;
      return;
    }
    // Hover matters on Facebook (menus, tooltips), but only for a mouse.
    if (active === null && e.pointerType !== 'mouse') return;
    const point = remotePoint(client, active !== null);
    if (point === null) return;
    sender.move(
      { _tag: 'mouse', action: 'move', ...point, button: active?.button ?? 'left', clickCount: 0 },
      active === null ? HOVER_MOVE_MS : DRAG_MOVE_MS,
    );
  };

  const onPointerUp = (e: PointerEvent<HTMLCanvasElement>) => {
    const active = pointerRef.current;
    if (active?.id !== e.pointerId) return;
    pointerRef.current = null;
    if (active.touch) {
      if (active.touch.swiping) return;
      const point = active.touch.startRemote;
      const clickCount = click(point, active.button, e.timeStamp);
      sender.send({ _tag: 'mouse', action: 'down', ...point, button: active.button, clickCount });
      sender.send({ _tag: 'mouse', action: 'up', ...point, button: active.button, clickCount });
      return;
    }
    const point = remotePoint({ x: e.clientX, y: e.clientY }, true);
    if (point === null) return;
    sender.cancelMove();
    sender.send({ _tag: 'mouse', action: 'up', ...point, button: active.button, clickCount: active.clickCount });
  };

  const onPointerCancel = (e: PointerEvent<HTMLCanvasElement>) => {
    const active = pointerRef.current;
    if (active?.id !== e.pointerId) return;
    pointerRef.current = null;
    // A cancelled mouse press still needs its release, or Facebook thinks the button is held.
    if (active.touch === null) {
      const point = remotePoint({ x: e.clientX, y: e.clientY }, true);
      if (point !== null) sender.send({ _tag: 'mouse', action: 'up', ...point, button: active.button, clickCount: active.clickCount });
    }
  };

  // Wheel listeners must be non-passive to keep the page from scrolling (React's onWheel is passive).
  const canvasCallbackRef = (canvas: HTMLCanvasElement | null) => {
    canvasRef.current = canvas;
    if (canvas === null) return;
    const onWheel = (e: WheelEvent) => {
      const point = remotePoint({ x: e.clientX, y: e.clientY }, false);
      if (point === null) return;
      e.preventDefault();
      sender.wheel(point.x, point.y, wheelPixels(e.deltaX, e.deltaMode, state.height), wheelPixels(e.deltaY, e.deltaMode, state.height));
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      canvas.removeEventListener('wheel', onWheel);
    };
  };

  // ---------- keyboard ----------

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const decision = decideKey({
      key: e.key,
      code: e.code,
      altKey: e.altKey,
      ctrlKey: e.ctrlKey,
      metaKey: e.metaKey,
      shiftKey: e.shiftKey,
      isComposing: e.nativeEvent.isComposing,
    });
    switch (decision.kind) {
      case 'send':
        // Also keeps Escape and Tab away from faceslop (dialogs, focus) while typing into Facebook.
        e.preventDefault();
        e.stopPropagation();
        sender.send(decision.event);
        break;
      case 'release-focus':
        e.preventDefault();
        e.stopPropagation();
        doneRef.current?.focus();
        break;
      case 'native':
      case 'ignore':
        break;
    }
  };

  // Phones and IMEs deliver text through input events instead of keydown.
  const onInput = (e: InputEvent<HTMLTextAreaElement>) => {
    const native = e.nativeEvent;
    const target = e.currentTarget;
    if (native.isComposing) return;
    switch (native.inputType) {
      case 'insertText':
      case 'insertReplacementText':
        if (native.data !== null && native.data !== '') sender.sendAll(textEvents(native.data));
        break;
      case 'insertLineBreak':
      case 'insertParagraph':
        sender.send(press('Enter'));
        break;
      case 'deleteContentBackward':
        sender.send(press('Backspace'));
        break;
      case 'deleteContentForward':
        sender.send(press('Delete'));
        break;
      default:
        break;
    }
    target.value = '';
  };

  const onCompositionEnd = (e: CompositionEvent<HTMLTextAreaElement>) => {
    if (e.data !== '') sender.sendAll(textEvents(e.data));
    e.currentTarget.value = '';
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    e.preventDefault();
    sender.sendAll(textEvents(e.clipboardData.getData('text/plain')));
  };

  const navigate = (action: 'back' | 'forward' | 'reload') => {
    sender.send({ _tag: 'navigate', action });
  };

  const title = state.title === null || state.title === '' ? 'Facebook' : state.title;
  const statusText = inputProblem ?? STATUS_TEXT[status];

  return (
    <section aria-label="Facebook, shown by faceslop" className="overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10">
      <div role="group" aria-label="Page controls" className="flex items-center gap-1 border-b px-2 py-1.5">
        <Button variant="ghost" size="icon-sm" aria-label="Back" onPress={() => { navigate('back'); }}>
          <ArrowLeft aria-hidden="true" />
        </Button>
        <Button variant="ghost" size="icon-sm" aria-label="Forward" onPress={() => { navigate('forward'); }}>
          <ArrowRight aria-hidden="true" />
        </Button>
        <Button variant="ghost" size="icon-sm" aria-label="Reload" onPress={() => { navigate('reload'); }}>
          <RotateCw aria-hidden="true" />
        </Button>
        <div className="min-w-0 flex-1 px-2">
          <p className="truncate text-sm font-medium" aria-live="polite">
            {title}
          </p>
          <p className="truncate text-xs text-muted-foreground">{shortUrl(state.url)}</p>
        </div>
        {statusText !== '' && (
          <p role="status" className="hidden max-w-48 truncate text-xs text-muted-foreground sm:block">
            {statusText}
          </p>
        )}
        <Button ref={doneRef} size="sm" isPending={closing} onPress={onDone}>
          {doneLabel}
        </Button>
      </div>

      <div className="relative bg-muted has-focus-visible:ring-3 has-focus-visible:ring-ring/50 has-focus-visible:ring-inset">
        {!hasFrame && (
          <div className="flex aspect-video w-full flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
            <Spinner aria-hidden="true" />
            Loading the page…
          </div>
        )}
        <div role="img" aria-label={`Live picture of the Facebook page: ${title}`} aria-describedby={instructionsId}>
          <canvas
            ref={canvasCallbackRef}
            className={cn(
              'mx-auto block h-auto w-full touch-none object-contain select-none',
              inDialog ? 'max-h-remote-dialog' : 'max-h-remote',
              !hasFrame && 'hidden',
            )}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerCancel}
            onContextMenu={(e) => {
              e.preventDefault();
            }}
          />
        </div>
        <textarea
          ref={keyboardRef}
          aria-label="Type into the Facebook page"
          aria-describedby={instructionsId}
          className="sr-only"
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
          rows={1}
          onKeyDown={onKeyDown}
          onInput={onInput}
          onCompositionEnd={onCompositionEnd}
          onPaste={onPaste}
        />
      </div>

      <p id={instructionsId} className="border-t px-3 py-2 text-xs text-muted-foreground">
        A live picture of facebook.com, running on your faceslop server. Click or tap it to use it and type as usual
        {statusText === '' ? '' : ` (${statusText.toLowerCase()})`}. Press Shift+Esc to move the keyboard back to
        faceslop. The picture is visual only; the title above follows the page for screen readers.
      </p>
    </section>
  );
}
