/**
 * 점심팟 관리자 대시보드.
 *
 * 슬랙봇이 쓰는 것과 똑같은 SQLite 파일을 읽어서 팟 현황을 보여줍니다.
 * (보기 전용입니다. 상태를 바꾸는 건 슬랙에서만 합니다.)
 *
 * 색상·글꼴은 전부 globals.css의 토큰(--bg-app, --text-primary 등)을 따릅니다.
 * 여기서 "dark:" 를 따로 쓰지 않는 이유는, 토큰 쪽에서 라이트/다크를 한 번에
 * 정의해두면 화면 쪽 코드는 라이트/다크를 몰라도 되기 때문입니다.
 */

import { Suspense } from "react";
import { connection } from "next/server";

import { AutoRefresh } from "./auto-refresh.tsx";
import { DateFilter } from "./date-filter.tsx";

import {
  formatWon,
  getParticipants,
  getUserNames,
  listPotDates,
  listPots,
  listPotsByDate,
  type Participant,
  type Pot,
} from "@/lib/pots.ts";
import {
  POT_STATUS,
  STATUS_EMOJI,
  STATUS_LABEL,
  STATUS_ORDER,
  statusStep,
  type PotStatus,
} from "@/lib/status.ts";

// Next.js 16 에서는 searchParams 가 Promise로 옵니다. (주소 뒤 ?date=... 를 읽는 부분)
type PageProps = {
  searchParams: Promise<{ date?: string }>;
};

export default async function Page({ searchParams }: PageProps) {
  const { date } = await searchParams;

  return (
    <main className="mx-auto w-full max-w-3xl px-5 py-10">
      <header className="mb-8">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-card text-lg shadow-[var(--shadow-card)]">
            🍚
          </span>
          <h1 className="text-[22px] font-semibold tracking-tight">점심팟 대시보드</h1>
        </div>
        <p className="mt-2 text-[13px] leading-relaxed text-secondary">
          슬랙에서{" "}
          <code className="rounded-md bg-card px-1.5 py-0.5 text-[12px] text-primary">
            /점심팟
          </code>{" "}
          으로 만든 팟의 모집 · 정산 현황
        </p>

        {/*
          자동 갱신 표시(왼쪽)와 날짜 선택(오른쪽)을 한 줄에 모아 하나의 도구줄처럼 보이게 합니다.
          화면이 좁으면 flex-wrap 으로 날짜 선택이 다음 줄로 자연스럽게 내려갑니다.
          (justify-between만 쓰면 좁을 때 글자가 세로로 쪼개져 보입니다)
        */}
        <div className="mt-5 flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
          {date ? (
            <p className="text-[13px] text-tertiary">지난 날짜를 보고 있어요</p>
          ) : (
            <AutoRefresh intervalMs={30_000} />
          )}
          <Suspense fallback={null}>
            <DateFilterBar selected={date ?? null} />
          </Suspense>
        </div>
      </header>

      {/*
        Suspense로 감싸는 이유:
        DB 읽기는 "요청이 들어온 순간"에 해야 최신 값이 나옵니다.
        이렇게 해두면 Next.js가 미리 만들어둔 화면 껍데기에 이 부분만 나중에 채워 넣습니다.
      */}
      <Suspense fallback={<p className="text-[13px] text-secondary">불러오는 중…</p>}>
        <PotList date={date ?? null} />
      </Suspense>
    </main>
  );
}

async function DateFilterBar({ selected }: { selected: string | null }) {
  await connection();
  const dates = listPotDates();
  if (dates.length === 0) return null; // 팟이 하나도 없으면 고를 날짜도 없습니다.
  return <DateFilter dates={dates} selected={selected} />;
}

async function PotList({ date }: { date: string | null }) {
  // connection(): "빌드할 때 미리 만들지 말고, 요청이 올 때마다 실행해줘"라는 표시입니다.
  // node:sqlite 처럼 동기 방식으로 읽는 DB는 이 줄이 없으면 빌드 시점의 값이 굳어버립니다.
  await connection();

  const pots = date ? listPotsByDate(date) : listPots();
  // 이름은 한 번에 다 읽어 옵니다. 팟마다 조회하면 같은 질의를 몇 번씩 반복하게 됩니다.
  const names = getUserNames();

  if (pots.length === 0) {
    return (
      <div className="rounded-3xl border border-dashed border-line bg-card/60 p-12 text-center">
        <p className="text-[15px] text-secondary">
          {date ? "이 날짜엔 팟이 없어요." : "아직 만들어진 팟이 없어요."}
        </p>
        <p className="mt-1.5 text-[13px] text-tertiary">
          슬랙 채널에서 <code>/점심팟</code> 을 입력해 첫 팟을 만들어 보세요.
        </p>
      </div>
    );
  }

  return (
    <ul className="space-y-3.5">
      {pots.map((pot) => (
        <PotCard
          key={pot.id}
          pot={pot}
          participants={getParticipants(pot.id)}
          names={names}
        />
      ))}
    </ul>
  );
}

function PotCard({
  pot,
  participants,
  names,
}: {
  pot: Pot;
  participants: Participant[];
  names: Map<string, string>;
}) {
  const payers = participants.filter((p) => p.slack_user_id !== pot.organizer_id);
  const paidCount = payers.filter((p) => p.paid === 1).length;
  const disputedCount = payers.filter((p) => p.disputed === 1).length;

  return (
    <li className="rounded-3xl border border-line bg-card p-5 shadow-[var(--shadow-card)] sm:p-6">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="truncate text-[15px] font-semibold tracking-tight">
            {STATUS_EMOJI[pot.status]} {pot.title}
          </h2>
          {/* 장소와 시간은 서로 다른 값이라 한 줄로 붙이지 않고 따로 보여줍니다. */}
          <p className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[13px] text-secondary">
            <span>📍 {pot.place ?? "미정"}</span>
            <span>🕐 {pot.meet_at ?? "미정"}</span>
            <span>👤 {names.get(pot.organizer_id) ?? pot.organizer_id}</span>
          </p>
        </div>
        <StatusBadge status={pot.status} />
      </div>

      <StatusTracker status={pot.status} />

      {pot.status === POT_STATUS.FINALIZED && (
        <p className="mt-2 text-[12px] text-tertiary">
          🏁 완전히 마무리됐어요. 더 이상 되돌릴 수 없어요.
        </p>
      )}

      <dl className="mt-5 grid grid-cols-2 gap-x-4 gap-y-3 text-[13px] sm:grid-cols-4">
        <Stat label="참여">
          {participants.length}명{pot.capacity > 0 ? ` / ${pot.capacity}` : ""}
        </Stat>
        <Stat label="총 금액">
          {pot.total_amount ? `${formatWon(pot.total_amount)}원` : "—"}
        </Stat>
        <Stat label="입금">{pot.total_amount ? `${paidCount} / ${payers.length}명` : "—"}</Stat>
        {/* 신고가 없으면 굳이 강조하지 않고 "없음"으로만 조용히 둡니다. */}
        <Stat label="이상 신고">
          {pot.total_amount ? (disputedCount > 0 ? `${disputedCount}명` : "없음") : "—"}
        </Stat>
      </dl>

      {/* 정산이 시작된 뒤에만 참여자별 금액 · 입금 여부를 보여줍니다. 사람마다 낼 금액이
          다를 수 있어서 pill 하나하나에 그 사람의 금액을 함께 적습니다. */}
      {pot.total_amount !== null && payers.length > 0 && (
        <ul className="mt-4 flex flex-wrap gap-2">
          {payers.map((p) => {
            const icon = p.paid === 1 ? "✅" : p.disputed === 1 ? "🚩" : "⬜";
            const style =
              p.paid === 1
                ? "bg-emerald-500/15 text-emerald-600"
                : p.disputed === 1
                  ? "bg-red-500/15 text-red-600"
                  : "bg-line/60 text-secondary";

            return (
              <li key={p.slack_user_id} className={`rounded-full px-2.5 py-1 text-[12px] font-medium ${style}`}>
                {/* 이름을 아직 못 알아낸 사람은 원래 ID로 보여줍니다. */}
                {icon} {names.get(p.slack_user_id) ?? p.slack_user_id}
                {p.amount ? ` · ${formatWon(p.amount)}원` : ""}
              </li>
            );
          })}
        </ul>
      )}
    </li>
  );
}

/**
 * 4단계 진행 표시. 지금 단계까지는 색이 차 있고, 지금 단계 위에는 작은 점을 얹어
 * "여기까지 왔다"는 걸 보여줍니다. (택배 배송 조회 화면과 비슷한 느낌)
 */
function StatusTracker({ status }: { status: PotStatus }) {
  const current = statusStep(status);

  // 취소된 팟은 4단계 흐름 밖이라 막대 대신 한 줄로 표시합니다.
  // (막대를 그리면 "0단계에 멈춘 팟"처럼 보여서 오해를 부릅니다)
  if (current === 0) {
    return (
      <p className="mt-5 border-t border-line pt-3.5 text-[13px] text-tertiary">
        진행이 중단된 팟이에요
      </p>
    );
  }

  return (
    <ol className="mt-5 flex gap-1.5">
      {STATUS_ORDER.map((s, index) => {
        const step = index + 1;
        const done = step <= current;
        const active = step === current;

        return (
          <li key={s} className="flex-1">
            <div className="relative">
              {active && (
                <span className="absolute -top-2 left-1/2 h-1.5 w-1.5 -translate-x-1/2 rounded-full bg-accent" />
              )}
              <div className={`h-1.5 rounded-full ${done ? "bg-accent" : "bg-line"}`} />
            </div>
            <span
              className={`mt-2 block text-[11px] ${
                active ? "font-semibold text-accent" : done ? "text-secondary" : "text-tertiary"
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
    RECRUITING: "bg-blue-500/15 text-blue-600",
    CLOSED: "bg-amber-500/15 text-amber-600",
    SETTLING: "bg-accent-soft text-accent",
    SETTLED: "bg-emerald-500/15 text-emerald-600",
    FINALIZED: "bg-violet-500/15 text-violet-600",
    // 취소됨은 눈에 덜 띄게 회색으로 둡니다. 진행 중인 팟을 가리지 않도록요.
    CANCELLED: "bg-line/60 text-tertiary",
  };

  return (
    <span
      className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold ${styles[status]}`}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-[11px] text-tertiary">{label}</dt>
      <dd className="mt-0.5 font-semibold tabular-nums">{children}</dd>
    </div>
  );
}
