/**
 * 점심팟 관리자 대시보드.
 *
 * 슬랙봇이 쓰는 것과 똑같은 SQLite 파일을 읽어서 팟 현황을 보여줍니다.
 * (보기 전용입니다. 상태를 바꾸는 건 슬랙에서만 합니다.)
 */

import { Suspense } from "react";
import { connection } from "next/server";

import {
  amountPerPerson,
  formatWon,
  getParticipants,
  listPots,
  type Participant,
  type Pot,
} from "@/lib/pots.ts";
import {
  STATUS_EMOJI,
  STATUS_LABEL,
  STATUS_ORDER,
  statusStep,
  type PotStatus,
} from "@/lib/status.ts";

export default function Page() {
  return (
    <main className="mx-auto w-full max-w-3xl px-5 py-10">
      <header className="mb-8">
        <h1 className="text-2xl font-bold tracking-tight">🍚 점심팟 대시보드</h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          슬랙에서{" "}
          <code className="rounded bg-slate-200 px-1 py-0.5 dark:bg-slate-800">/점심팟</code> 으로
          만든 팟의 모집 · 정산 현황
        </p>
      </header>

      {/*
        Suspense로 감싸는 이유:
        DB 읽기는 "요청이 들어온 순간"에 해야 최신 값이 나옵니다.
        이렇게 해두면 Next.js가 미리 만들어둔 화면 껍데기에 이 부분만 나중에 채워 넣습니다.
      */}
      <Suspense fallback={<p className="text-sm text-slate-500">불러오는 중…</p>}>
        <PotList />
      </Suspense>
    </main>
  );
}

async function PotList() {
  // connection(): "빌드할 때 미리 만들지 말고, 요청이 올 때마다 실행해줘"라는 표시입니다.
  // node:sqlite 처럼 동기 방식으로 읽는 DB는 이 줄이 없으면 빌드 시점의 값이 굳어버립니다.
  await connection();

  const pots = listPots();

  if (pots.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-slate-300 p-10 text-center dark:border-slate-700">
        <p className="text-slate-500 dark:text-slate-400">아직 만들어진 팟이 없어요.</p>
        <p className="mt-1 text-sm text-slate-400 dark:text-slate-500">
          슬랙 채널에서 <code>/점심팟</code> 을 입력해 첫 팟을 만들어 보세요.
        </p>
      </div>
    );
  }

  return (
    <ul className="space-y-4">
      {pots.map((pot) => (
        <PotCard key={pot.id} pot={pot} participants={getParticipants(pot.id)} />
      ))}
    </ul>
  );
}

function PotCard({ pot, participants }: { pot: Pot; participants: Participant[] }) {
  const perPerson = pot.total_amount
    ? amountPerPerson(pot.total_amount, participants.length)
    : null;
  const payers = participants.filter((p) => p.slack_user_id !== pot.organizer_id);
  const paidCount = payers.filter((p) => p.paid === 1).length;

  return (
    <li className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="font-semibold">
            {STATUS_EMOJI[pot.status]} {pot.title}
          </h2>
          {/* 장소와 시간은 서로 다른 값이라 한 줄로 붙이지 않고 따로 보여줍니다. */}
          <p className="mt-1 flex flex-wrap gap-x-3 text-sm text-slate-500 dark:text-slate-400">
            <span>📍 {pot.place ?? "미정"}</span>
            <span>🕐 {pot.meet_at ?? "미정"}</span>
          </p>
        </div>
        <StatusBadge status={pot.status} />
      </div>

      <StatusTracker status={pot.status} />

      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4">
        <Stat label="참여">
          {participants.length}명{pot.capacity > 0 ? ` / ${pot.capacity}` : ""}
        </Stat>
        <Stat label="총 금액">
          {pot.total_amount ? `${formatWon(pot.total_amount)}원` : "—"}
        </Stat>
        <Stat label="1인당">{perPerson ? `${formatWon(perPerson)}원` : "—"}</Stat>
        <Stat label="입금">{pot.total_amount ? `${paidCount} / ${payers.length}명` : "—"}</Stat>
      </dl>

      {/* 정산이 시작된 뒤에만 누가 입금했는지 보여줍니다. */}
      {pot.total_amount !== null && payers.length > 0 && (
        <ul className="mt-4 flex flex-wrap gap-2">
          {payers.map((p) => (
            <li
              key={p.slack_user_id}
              className={`rounded-full px-2.5 py-1 text-xs ${
                p.paid === 1
                  ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"
                  : "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400"
              }`}
            >
              {p.paid === 1 ? "✅" : "⬜"} {p.slack_user_id}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

/** 4단계 진행 막대. 지금 단계까지는 색이 차 있고, 이후는 회색입니다. */
function StatusTracker({ status }: { status: PotStatus }) {
  const current = statusStep(status);

  return (
    <ol className="mt-4 flex gap-1.5">
      {STATUS_ORDER.map((s, index) => {
        const done = index + 1 <= current;
        return (
          <li key={s} className="flex-1">
            <div
              className={`h-1.5 rounded-full ${
                done ? "bg-indigo-500" : "bg-slate-200 dark:bg-slate-800"
              }`}
            />
            <span
              className={`mt-1.5 block text-[11px] ${
                done
                  ? "font-medium text-indigo-600 dark:text-indigo-400"
                  : "text-slate-400 dark:text-slate-600"
              }`}
            >
              {STATUS_LABEL[s]}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function StatusBadge({ status }: { status: PotStatus }) {
  const styles: Record<PotStatus, string> = {
    RECRUITING: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
    CLOSED: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
    SETTLING: "bg-purple-100 text-purple-700 dark:bg-purple-950 dark:text-purple-300",
    SETTLED: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  };

  return (
    <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${styles[status]}`}>
      {STATUS_LABEL[status]}
    </span>
  );
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-slate-400 dark:text-slate-500">{label}</dt>
      <dd className="font-medium tabular-nums">{children}</dd>
    </div>
  );
}
