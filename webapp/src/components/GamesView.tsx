import { useEffect, useMemo, useRef, useState } from 'react';
import { Chess, type Color, type Move, type PieceSymbol, type Square } from 'chess.js';
import { ArrowRight, ChessKnight, CircleCheck, CircleDashed, Crown, RotateCcw, Trophy, Undo2, Zap } from 'lucide-react';

type GameTab = 'chess';
type Difficulty = 'adaptive' | '1' | '2' | '3' | '4' | '5';
type Outcome = 'win' | 'loss' | 'draw';

interface Score {
  rating: number;
  wins: number;
  losses: number;
  draws: number;
}

interface StoredScore {
  score: Score;
  warning: string;
}

interface PersistedChessState {
  version: 1;
  score: Score;
  difficulty: Difficulty;
  fen: string;
  pgn: string;
  result: { outcome: Outcome; delta: number } | null;
  history: Array<{ outcome: Outcome; delta: number; opponentRating: number; completedAt: number; pgn: string }>;
  updatedAt: number;
}

const STARTING_FEN = new Chess().fen();
const STARTING_SCORE: Score = { rating: 1000, wins: 0, losses: 0, draws: 0 };
const INITIAL_CHESS_STATE: PersistedChessState = {
  version: 1,
  score: STARTING_SCORE,
  difficulty: 'adaptive',
  fen: STARTING_FEN,
  pgn: '',
  result: null,
  history: [],
  updatedAt: Date.now(),
};

const GAME_TABS: { id: GameTab; label: string; icon: typeof ChessKnight }[] = [
  { id: 'chess', label: 'Chess', icon: ChessKnight },
];

const OPPONENT_RATINGS = [900, 1100, 1300, 1500, 1700];
const PIECE_VALUES: Record<PieceSymbol, number> = { p: 100, n: 320, b: 335, r: 500, q: 900, k: 0 };
const PIECE_GLYPHS: Record<Color, Record<PieceSymbol, string>> = {
  w: { k: '♔', q: '♕', r: '♖', b: '♗', n: '♘', p: '♙' },
  b: { k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' },
};
const FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
const DIFFICULTY_LABELS = ['I · Gentle', 'II · Steady', 'III · Focused', 'IV · Keen', 'V · Formidable'];

function readScore(): StoredScore {
  try {
    const saved = window.localStorage.getItem('symbiote-chess-score');
    if (!saved) return { score: STARTING_SCORE, warning: '' };
    const value: unknown = JSON.parse(saved);
    if (!value || typeof value !== 'object') throw new Error('Saved chess score is not valid.');
    const record = value as Partial<Score>;
    if (
      typeof record.rating !== 'number' || !Number.isFinite(record.rating) ||
      typeof record.wins !== 'number' || typeof record.losses !== 'number' || typeof record.draws !== 'number'
    ) throw new Error('Saved chess score is not valid.');
    return {
      score: {
        rating: Math.max(100, Math.round(record.rating)),
        wins: Math.max(0, Math.floor(record.wins)),
        losses: Math.max(0, Math.floor(record.losses)),
        draws: Math.max(0, Math.floor(record.draws)),
      },
      warning: '',
    };
  } catch (failure) {
    return {
      score: STARTING_SCORE,
      warning: `Chess score could not be read: ${failure instanceof Error ? failure.message : 'browser storage is unavailable'}`,
    };
  }
}

function adaptiveLevel(rating: number): number {
  return Math.max(1, Math.min(5, Math.floor((rating - 800) / 200) + 1));
}

function orderedMoves(game: Chess): Move[] {
  return game.moves({ verbose: true }).sort((left, right) => {
    const value = (move: Move) => (move.captured ? PIECE_VALUES[move.captured] * 10 : 0) + (move.promotion ? PIECE_VALUES[move.promotion] : 0);
    return value(right) - value(left);
  });
}

function evaluatePosition(game: Chess): number {
  if (game.isCheckmate()) return game.turn() === 'w' ? -100_000 : 100_000;
  if (game.isDraw()) return 0;

  let score = 0;
  game.board().forEach((row, rank) => row.forEach((piece, file) => {
    if (!piece) return;
    const material = PIECE_VALUES[piece.type];
    const centrality = 3.5 - (Math.abs(file - 3.5) + Math.abs(rank - 3.5)) / 2;
    const positional = piece.type === 'p' ? (piece.color === 'w' ? 6 - rank : rank - 1) * 5 : centrality * (piece.type === 'n' || piece.type === 'b' ? 8 : 2);
    score += (piece.color === 'w' ? 1 : -1) * (material + positional);
  }));
  return score;
}

function searchPosition(game: Chess, depth: number, alpha: number, beta: number): number {
  if (depth === 0 || game.isGameOver()) return evaluatePosition(game);
  const maximizing = game.turn() === 'w';
  let best = maximizing ? -Infinity : Infinity;

  for (const move of orderedMoves(game)) {
    game.move(move);
    const value = searchPosition(game, depth - 1, alpha, beta);
    game.undo();
    if (maximizing) {
      best = Math.max(best, value);
      alpha = Math.max(alpha, best);
    } else {
      best = Math.min(best, value);
      beta = Math.min(beta, best);
    }
    if (beta <= alpha) break;
  }
  return best;
}

function chooseComputerMove(game: Chess, level: number): Move | undefined {
  const moves = orderedMoves(game);
  if (!moves.length) return undefined;
  if (level === 1) return moves[Math.floor(Math.random() * moves.length)];

  const depth = level === 2 ? 1 : level === 3 ? 2 : level === 4 ? 2 : 3;
  let bestMove = moves[0];
  let bestScore = Infinity;
  for (const move of moves) {
    game.move(move);
    const score = searchPosition(game, depth - 1, -Infinity, Infinity);
    game.undo();
    if (score < bestScore) {
      bestScore = score;
      bestMove = move;
    }
  }
  return bestMove;
}

function eloChange(rating: number, opponentRating: number, outcome: Outcome): number {
  const actual = outcome === 'win' ? 1 : outcome === 'draw' ? 0.5 : 0;
  const expected = 1 / (1 + 10 ** ((opponentRating - rating) / 400));
  return Math.round(32 * (actual - expected));
}

function isPersistedChessState(value: unknown): value is PersistedChessState {
  if (!value || typeof value !== 'object') return false;
  const state = value as Partial<PersistedChessState>;
  const score = state.score;
  const valid = state.version === 1
    && !!score && Number.isSafeInteger(score.rating) && score.rating >= 100
    && Number.isSafeInteger(score.wins) && score.wins >= 0
    && Number.isSafeInteger(score.losses) && score.losses >= 0
    && Number.isSafeInteger(score.draws) && score.draws >= 0
    && ['adaptive', '1', '2', '3', '4', '5'].includes(String(state.difficulty))
    && typeof state.fen === 'string' && state.fen.length <= 120
    && typeof state.pgn === 'string' && state.pgn.length <= 30_000
    && Array.isArray(state.history) && state.history.length <= 100
    && state.history.every(item => !!item && ['win', 'loss', 'draw'].includes(item.outcome)
      && Number.isSafeInteger(item.delta) && Number.isSafeInteger(item.opponentRating)
      && Number.isSafeInteger(item.completedAt) && typeof item.pgn === 'string' && item.pgn.length <= 30_000)
    && Number.isSafeInteger(state.updatedAt)
    && (state.result === null || (!!state.result && ['win', 'loss', 'draw'].includes(state.result.outcome)
      && Number.isSafeInteger(state.result.delta)));
  if (!valid) return false;
  try {
    const game = new Chess();
    if (state.pgn) game.loadPgn(state.pgn);
    else if (state.fen && state.fen !== STARTING_FEN) game.load(state.fen);
    return game.fen() === state.fen;
  } catch {
    return false;
  }
}

function GamesView({ request }: { request: <T>(endpoint: string, options?: RequestInit) => Promise<T> }) {
  const [activeGame, setActiveGame] = useState<GameTab>('chess');
  const legacyScore = useMemo(readScore, []);
  const [state, setState] = useState<PersistedChessState>(() => ({ ...INITIAL_CHESS_STATE, score: legacyScore.score }));
  const [storageWarning, setStorageWarning] = useState(legacyScore.warning);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void request<{ state?: unknown }>('/api/games/chess')
      .then(async result => {
        if (cancelled) return;
        if (result.state !== null && result.state !== undefined) {
          if (!isPersistedChessState(result.state)) throw new Error('Saved chess state has an unsupported or invalid format.');
          setState(result.state);
        } else {
          await request('/api/games/chess', { method: 'PUT', body: JSON.stringify({ state }) });
        }
        setLoaded(true);
      })
      .catch(failure => {
        if (cancelled) return;
        setStorageWarning(`Chess state could not be loaded: ${failure instanceof Error ? failure.message : 'unknown error'}`);
        setLoaded(true);
      });
    return () => { cancelled = true; };
  }, [request]);

  const saveState = (next: PersistedChessState) => {
    setState(next);
    setStorageWarning('');
    void request<{ state: PersistedChessState }>('/api/games/chess', {
      method: 'PUT',
      body: JSON.stringify({ state: next }),
    }).catch(failure => setStorageWarning(`Chess state could not be saved: ${failure instanceof Error ? failure.message : 'unknown error'}`));
  };

  const active = GAME_TABS.find(game => game.id === activeGame) ?? GAME_TABS[0];
  return (
    <div className="page games-page">
      <header className="games-heading">
        <div>
          <div className="eyebrow">ZEN · GAMES</div>
          <h1>A quieter kind of focus.</h1>
          <p>Choose a game.</p>
        </div>
        <div className="games-heading-mark" aria-hidden="true"><ChessKnight size={23} strokeWidth={1.45} /></div>
      </header>

      <nav className="game-tabs" aria-label="Games">
        {GAME_TABS.map(game => {
          const Icon = game.icon;
          return (
            <button
              key={game.id}
              type="button"
              className={`game-tab${activeGame === game.id ? ' game-tab-active' : ''}`}
              onClick={() => setActiveGame(game.id)}
              aria-current={activeGame === game.id ? 'page' : undefined}
            >
              <Icon size={17} strokeWidth={1.7} />
              <span>{game.label}</span>
            </button>
          );
        })}
      </nav>

      <section className="game-section" aria-label={active.label}>
        {!loaded
          ? <div className="loading-state"><span>Restoring saved match…</span></div>
          : activeGame === 'chess' && <ChessGame state={state} onStateChange={saveState} storageWarning={storageWarning} />}
      </section>
    </div>
  );
}

function ChessGame({ state, onStateChange, storageWarning }: {
  state: PersistedChessState;
  onStateChange: (state: PersistedChessState) => void;
  storageWarning: string;
}) {
  const gameRef = useRef<Chess | null>(null);
  if (!gameRef.current) {
    const restored = new Chess();
    if (state.pgn) restored.loadPgn(state.pgn);
    else if (state.fen && state.fen !== STARTING_FEN) restored.load(state.fen);
    if (state.fen && restored.fen() !== state.fen) throw new Error('Saved chess position does not match its move history.');
    gameRef.current = restored;
  }
  const game = gameRef.current;
  if (!game) throw new Error('Chess engine could not be initialized.');
  const { score, difficulty } = state;
  const timerRef = useRef<number | undefined>(undefined);
  const [position, setPosition] = useState(game.fen());
  const [selected, setSelected] = useState<Square | null>(null);
  const [targets, setTargets] = useState<Square[]>([]);
  const [thinking, setThinking] = useState(false);
  const [result, setResult] = useState<{ outcome: Outcome; delta: number } | null>(state.result);
  const [lastMove, setLastMove] = useState<Move | null>(game.history({ verbose: true }).at(-1) ?? null);
  const [notice, setNotice] = useState('');
  const board = useMemo(() => new Chess(position).board(), [position]);
  const level = difficulty === 'adaptive' ? adaptiveLevel(score.rating) : Number(difficulty);
  const history = game.history({ verbose: true });
  const castleMoves = game.turn() === 'w'
    ? game.moves({ verbose: true }).filter(move => move.flags.includes('k') || move.flags.includes('q'))
    : [];

  useEffect(() => {
    if (game.turn() === 'b' && !game.isGameOver()) {
      setThinking(true);
      timerRef.current = window.setTimeout(playComputer, 240);
    }
    return () => window.clearTimeout(timerRef.current);
  }, []);

  const persistPosition = (overrides: Partial<PersistedChessState> = {}) => {
    onStateChange({
      ...state,
      ...overrides,
      fen: game.fen(),
      pgn: game.pgn(),
      updatedAt: Date.now(),
    });
  };

  const completeGame = (game: Chess) => {
    if (!game.isGameOver() || result) return;
    const outcome: Outcome = game.isDraw() ? 'draw' : game.turn() === 'b' ? 'win' : 'loss';
    const nextRating = Math.max(100, score.rating + eloChange(score.rating, OPPONENT_RATINGS[level - 1], outcome));
    const delta = nextRating - score.rating;
    const nextScore = {
      rating: nextRating,
      wins: score.wins + (outcome === 'win' ? 1 : 0),
      losses: score.losses + (outcome === 'loss' ? 1 : 0),
      draws: score.draws + (outcome === 'draw' ? 1 : 0),
    };
    const nextResult = { outcome, delta };
    setResult(nextResult);
    persistPosition({
      score: nextScore,
      result: nextResult,
      history: [{ ...nextResult, opponentRating: OPPONENT_RATINGS[level - 1], completedAt: Date.now(), pgn: game.pgn() }, ...state.history].slice(0, 100),
    });
  };

  const playComputer = () => {
    if (game.isGameOver()) {
      completeGame(game);
      return;
    }
    const move = chooseComputerMove(game, level);
    if (!move) return;
    const played = game.move({ from: move.from, to: move.to, promotion: move.promotion });
    setLastMove(played);
    setPosition(game.fen());
    setThinking(false);
    if (game.isGameOver()) completeGame(game);
    else persistPosition();
  };

  const playHumanMove = (move: Pick<Move, 'from' | 'to' | 'promotion'>) => {
    if (thinking || result || game.turn() !== 'w') return;
    try {
      const played = game.move({ from: move.from, to: move.to, promotion: move.promotion ?? 'q' });
      setLastMove(played);
      setPosition(game.fen());
      setSelected(null);
      setTargets([]);
      setNotice('');
      if (game.isGameOver()) {
        completeGame(game);
        return;
      }
      persistPosition();
      setThinking(true);
      timerRef.current = window.setTimeout(playComputer, 240);
    } catch (failure) {
      setNotice(failure instanceof Error ? failure.message : 'That move could not be played.');
    }
  };

  const selectSquare = (square: Square) => {
    if (thinking || result || game.turn() !== 'w') return;
    const piece = game.get(square);
    if (selected && targets.includes(square)) {
      playHumanMove({ from: selected, to: square, promotion: 'q' });
      return;
    }
    if (piece?.color === 'w') {
      setSelected(square);
      setTargets(game.moves({ square, verbose: true }).map(move => move.to));
      setNotice('');
    } else {
      setSelected(null);
      setTargets([]);
    }
  };

  const startNewGame = () => {
    window.clearTimeout(timerRef.current);
    game.reset();
    setPosition(game.fen());
    setSelected(null);
    setTargets([]);
    setThinking(false);
    setResult(null);
    setLastMove(null);
    setNotice('');
    persistPosition({ result: null, pgn: '' });
  };

  const undoTurn = () => {
    if (thinking || game.history().length < 2) return;
    game.undo();
    game.undo();
    setPosition(game.fen());
    setLastMove(game.history({ verbose: true }).at(-1) ?? null);
    setSelected(null);
    setTargets([]);
    setResult(null);
    setNotice('');
    persistPosition({ result: null });
  };

  const gameStatus = result
    ? result.outcome === 'win' ? 'A win, well played.' : result.outcome === 'loss' ? 'The board goes to the other side.' : 'A balanced game.'
    : thinking ? 'The other side is considering its move…'
      : game.isCheck() ? 'Check — find a safe square for your king.'
        : 'Your move · playing as White';

  return (
    <div className="chess-layout">
      <div className="chess-board-column">
        <div className="chess-board-frame">
          <div className="chess-board" role="grid" aria-label="Chess board. You are playing as White.">
            {board.map((row, rank) => row.map((piece, file) => {
              const square = `${FILES[file]}${8 - rank}` as Square;
              const isLight = (rank + file) % 2 === 1;
              const isSelected = selected === square;
              const isTarget = targets.includes(square);
              const isLastMove = lastMove?.from === square || lastMove?.to === square;
              const glyph = piece ? PIECE_GLYPHS[piece.color][piece.type] : '';
              const pieceName = piece ? `${piece.color === 'w' ? 'white' : 'black'} ${piece.type}` : 'empty';
              return (
                <button
                  key={square}
                  type="button"
                  role="gridcell"
                  className={`chess-square ${isLight ? 'square-light' : 'square-dark'}${isSelected ? ' square-selected' : ''}${isTarget ? ' square-target' : ''}${isLastMove ? ' square-last-move' : ''}`}
                  onClick={() => selectSquare(square)}
                  aria-label={`${square}, ${pieceName}${isTarget ? ', legal destination' : ''}`}
                  aria-selected={isSelected}
                  disabled={thinking || Boolean(result)}
                >
                  {file === 0 && <span className="square-rank">{8 - rank}</span>}
                  {rank === 7 && <span className="square-file">{FILES[file]}</span>}
                  {isTarget && !piece && <span className="move-dot" />}
                  {isTarget && piece && <span className="capture-ring" />}
                  {piece && <span className={`chess-piece piece-${piece.color}`} aria-hidden="true">{glyph}</span>}
                </button>
              );
            }))}
          </div>
        </div>
        <div className="board-caption"><span>{game.turn() === 'w' ? 'WHITE TO MOVE' : 'BLACK TO MOVE'}</span><span>CLASSICAL · 2D</span></div>
        {castleMoves.length > 0 && <div className="chess-castling" aria-label="Legal castling moves">
          <span>Castle</span>
          {castleMoves.map(move => <button key={move.san} type="button" className="button button-secondary" onClick={() => playHumanMove(move)} disabled={thinking}>
            {move.flags.includes('k') ? 'King side · O-O' : 'Queen side · O-O-O'}
          </button>)}
        </div>}
      </div>

      <aside className="chess-panel">
        <div className="chess-opponent">
          <div className="opponent-emblem"><Crown size={17} /></div>
          <div><span className="eyebrow">OPPONENT · LEVEL {level}</span><h3>The Quiet Strategist</h3></div>
          <span className={`thinking-indicator${thinking ? ' thinking-active' : ''}`} title={thinking ? 'Thinking' : 'Waiting'}><CircleDashed size={15} /></span>
        </div>
        <div className={`chess-status${result ? ` chess-status-${result.outcome}` : ''}`} aria-live="polite">
          <span className="status-mark">{result?.outcome === 'win' ? <Trophy size={15} /> : result ? <CircleCheck size={15} /> : <Zap size={15} />}</span>
          <span>{gameStatus}{result && <small>{result.delta >= 0 ? '+' : ''}{result.delta} rating points</small>}</span>
        </div>
        {notice && <div className="chess-notice" role="alert">{notice}</div>}
        {storageWarning && <div className="chess-notice" role="status">{storageWarning}</div>}

        <label className="difficulty-field" htmlFor="chess-difficulty">
          <span>Difficulty</span>
          <select id="chess-difficulty" value={difficulty} onChange={event => persistPosition({ difficulty: event.target.value as Difficulty })} disabled={thinking}>
            <option value="adaptive">Adaptive · follows your rating</option>
            {DIFFICULTY_LABELS.map((label, index) => <option key={label} value={index + 1}>Level {label}</option>)}
          </select>
        </label>

        <div className="chess-score-card">
          <div className="score-main"><span className="eyebrow">YOUR RATING</span><strong>{score.rating.toLocaleString()}</strong><small>Updates after each finished match</small></div>
          <div className="score-record">
            <span><strong>{score.wins}</strong>Wins</span>
            <span><strong>{score.draws}</strong>Draws</span>
            <span><strong>{score.losses}</strong>Losses</span>
          </div>
        </div>

        <div className="move-list">
          <div className="move-list-heading"><span>Move record</span><span>{history.length} ply</span></div>
          <div className="move-list-body" aria-label="Moves played">
            {history.length ? (
              Array.from({ length: Math.ceil(history.length / 2) }, (_, index) => (
                <div className="move-pair" key={index}>
                  <span>{index + 1}.</span><strong>{history[index * 2]?.san}</strong><strong>{history[index * 2 + 1]?.san ?? '·'}</strong>
                </div>
              ))
            ) : <p className="move-list-empty">Your opening move is waiting.</p>}
          </div>
        </div>

        <details className="chess-match-history">
          <summary>Recent matches <span>{state.history.length}</span></summary>
          {state.history.length
            ? <div className="chess-match-history-list">{state.history.slice(0, 5).map((match, index) => <div key={`${match.completedAt}-${index}`}>
              <strong className={`match-outcome match-${match.outcome}`}>{match.outcome}</strong>
              <span>{match.delta >= 0 ? '+' : ''}{match.delta} · opponent {match.opponentRating}</span>
              <time>{new Date(match.completedAt).toLocaleDateString()}</time>
            </div>)}</div>
            : <p className="move-list-empty">Completed matches will appear here.</p>}
        </details>

        <div className="chess-actions">
          <button type="button" className="button button-secondary" onClick={undoTurn} disabled={thinking || history.length < 2 || Boolean(result)}><Undo2 size={14} />Undo turn</button>
          <button type="button" className="button button-primary" onClick={startNewGame}><RotateCcw size={14} />New match<ArrowRight size={13} /></button>
        </div>
        <p className="chess-footnote">Elo scoring · {OPPONENT_RATINGS[level - 1]} opponent rating · saved to the shared session store</p>
      </aside>
    </div>
  );
}

export default GamesView;
