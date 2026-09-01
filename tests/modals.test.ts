/**
 * 모달 구조 테스트.
 *
 * 화면에 적힌 것과 실제 동작이 어긋나는 걸 잡습니다.
 * 실제로 있었던 문제:
 *   - 계좌 칸이 "(옵션)"이라고 적혀 있는데 비우고 제출하면 오류가 났다
 *   - 칸 이름을 코드 양쪽에 따로 적어서 한쪽만 고쳤을 때 조용히 어긋났다
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { setUpTempDb } from './helpers.ts';

setUpTempDb();
const B = await import('../src/lib/blocks.ts');
const { POT_STATUS } = await import('../src/lib/status.ts');

/**
 * 모달에서 입력칸만 골라냅니다.
 *
 * Block Kit 타입은 칸 종류마다 모양이 달라서, 테스트에서 확인하려는 부분만
 * 추려서 씁니다. (element 안은 종류별로 제각각이라 unknown 으로 둡니다)
 */
type InputBlock = {
  type: string;
  block_id?: string;
  optional?: boolean;
  element: Record<string, unknown>;
};

function inputs(view: { blocks: readonly unknown[] }): InputBlock[] {
  return (view.blocks as InputBlock[]).filter((b) => b.type === 'input');
}

const fakePot = {
  id: 1,
  title: '테스트',
  bank_name: null,
  account_number: null,
  account_holder: null,
} as Parameters<typeof B.startSettlementModal>[0];

const fakePayers = [{ slack_user_id: 'U_A' }, { slack_user_id: 'U_B' }] as Parameters<
  typeof B.startSettlementModal
>[1];
const noNames = new Map<string, string>();

describe('칸 이름은 FIELD 목록 또는 참여자별 금액칸 이름이어야 한다', () => {
  const known = new Set<string>(Object.values(B.FIELD));
  const knownAmountFields = new Set(fakePayers.map((p) => B.amountBlockId(p.slack_user_id)));

  const modals = {
    '팟 만들기 (배달)': B.createPotModal('DELIVERY', 'C1', null),
    '팟 만들기 (외식)': B.createPotModal('DINE_OUT', 'C1', null),
    '내기 만들기': B.createBetModal('C1'),
    '정산 시작': B.startSettlementModal(fakePot, fakePayers, noNames, null),
    '계좌 등록': B.saveAccountModal(null),
  };

  for (const [name, view] of Object.entries(modals)) {
    test(`${name} 모달`, () => {
      for (const block of inputs(view)) {
        assert.ok(
          known.has(block.block_id!) || knownAmountFields.has(block.block_id!),
          `${block.block_id} 는 FIELD 에도, 참여자별 금액칸에도 없는 이름`,
        );
      }
    });
  }
});

describe('정산 시작: 참여자별 금액 입력칸', () => {
  test('파티장을 뺀 참여자 수만큼 금액 입력칸이 생긴다', () => {
    const view = B.startSettlementModal(fakePot, fakePayers, noNames, null);
    const ids = inputs(view)
      .map((b) => b.block_id)
      .filter((id) => id?.startsWith('amount:'));
    assert.deepEqual(ids, fakePayers.map((p) => B.amountBlockId(p.slack_user_id)));
  });

  test('이름을 알면 라벨에 ID 대신 이름이 보인다', () => {
    const names = new Map([['U_A', '민수']]);
    const view = B.startSettlementModal(fakePot, fakePayers, names, null);
    const byId = new Map(
      inputs(view).map((b) => [b.block_id, b as unknown as { label: { text: string } }]),
    );

    assert.equal(byId.get(B.amountBlockId('U_A'))!.label.text, '민수');
    // 이름을 모르면 ID 그대로 보여줍니다.
    assert.equal(byId.get(B.amountBlockId('U_B'))!.label.text, 'U_B');
  });
});

describe('필수·선택 표시가 실제 동작과 맞아야 한다', () => {
  test('팟 만들기: 계좌는 진짜 선택 사항 — 나중에 정산할 때 넣어도 된다', () => {
    const byId = new Map(inputs(B.createPotModal('DELIVERY', 'C1', null)).map((b) => [b.block_id, b]));
    for (const id of B.ACCOUNT_FIELDS) {
      assert.equal(byId.get(id)?.optional, true, `${id} 는 선택이어야 함`);
    }
  });

  test('팟 만들기: 메뉴와 장소는 필수 (배달·외식 둘 다)', () => {
    for (const kind of ['DELIVERY', 'DINE_OUT'] as const) {
      const byId = new Map(inputs(B.createPotModal(kind, 'C1', null)).map((b) => [b.block_id, b]));
      assert.notEqual(byId.get(B.FIELD.TITLE)?.optional, true);
      assert.notEqual(byId.get(B.FIELD.PLACE)?.optional, true);
    }
  });

  test('정산 시작: 계좌는 필수 — 없으면 DM을 보낼 수 없다', () => {
    // 예전에는 여기가 optional 이라 "(옵션)"으로 보였는데
    // 비우고 제출하면 "모두 입력해 주세요" 오류가 났습니다.
    const byId = new Map(
      inputs(B.startSettlementModal(fakePot, fakePayers, noNames, null)).map((b) => [b.block_id, b]),
    );
    for (const id of B.ACCOUNT_FIELDS) {
      assert.notEqual(byId.get(id)?.optional, true, `${id} 는 필수여야 함`);
    }
  });

  test('계좌 등록: 세 칸 모두 필수', () => {
    const byId = new Map(inputs(B.saveAccountModal(null)).map((b) => [b.block_id, b]));
    for (const id of B.ACCOUNT_FIELDS) {
      assert.notEqual(byId.get(id)?.optional, true);
    }
  });
});

describe('장소: 배달은 드롭다운, 외식은 자유 입력', () => {
  test('배달 — 선택지가 PLACES 와 같다', () => {
    const place = inputs(B.createPotModal('DELIVERY', 'C1', null)).find(
      (b) => b.block_id === B.FIELD.PLACE,
    )!;

    assert.equal(place.element.type, 'static_select');
    assert.deepEqual(
      (place.element.options as { value: string }[]).map((o) => o.value),
      [...B.PLACES],
    );
  });

  test('외식 — 가게 이름·주소를 직접 적는 글자 입력칸', () => {
    const place = inputs(B.createPotModal('DINE_OUT', 'C1', null)).find(
      (b) => b.block_id === B.FIELD.PLACE,
    )!;

    assert.equal(place.element.type, 'plain_text_input');
  });
});

describe('외식 팟 메시지: 주소를 적으면 지도 링크가 붙는다', () => {
  const dineOutPot = {
    id: 1,
    channel_id: 'C',
    message_ts: null,
    organizer_id: 'U',
    pot_type: 'DINE_OUT',
    title: '냉면',
    place: '서울 강남구 테헤란로 123',
    meet_at: null,
    capacity: 0,
    status: POT_STATUS.RECRUITING,
    bank_name: null,
    account_number: null,
    account_holder: null,
    total_amount: null,
    created_at: '',
    updated_at: '',
  } as Parameters<typeof B.potMessage>[0];

  test('장소 줄에 카카오맵 검색 링크가 포함된다', () => {
    const blocks = B.potMessage(dineOutPot, []);
    const text = JSON.stringify(blocks);
    assert.ok(text.includes(B.kakaoMapSearchUrl(dineOutPot.place!)));
  });

  test('배달 팟(같은 place 값)에는 지도 링크가 없다', () => {
    const blocks = B.potMessage({ ...dineOutPot, pot_type: 'DELIVERY' }, []);
    const text = JSON.stringify(blocks);
    assert.ok(!text.includes('map.kakao.com'));
  });
});

describe('계좌 저장 동의 체크박스', () => {
  test('등록해둔 계좌가 없으면 꺼진 채로 열린다 — 묻지 않고 저장하지 않는다', () => {
    const box = inputs(B.startSettlementModal(fakePot, fakePayers, noNames, null)).find(
      (b) => b.block_id === B.FIELD.REMEMBER_ACCOUNT,
    )!;

    assert.equal(box.element.initial_options, undefined);
  });

  test('이미 등록해둔 사람은 켜진 채로 열린다', () => {
    const saved = { bank_name: 'ㅇ', account_number: '1', account_holder: 'ㄱ' };
    const box = inputs(B.startSettlementModal(fakePot, fakePayers, noNames, saved)).find(
      (b) => b.block_id === B.FIELD.REMEMBER_ACCOUNT,
    )!;

    assert.equal((box.element.initial_options as unknown[]).length, 1);
  });
});

describe('상태별 버튼', () => {
  /** 그 상태에서 보이는 버튼들의 action_id 목록. */
  function buttonsFor(status: string): string[] {
    const pot = {
      id: 1,
      channel_id: 'C',
      message_ts: null,
      organizer_id: 'U',
      title: 't',
      place: null,
      meet_at: null,
      capacity: 0,
      status,
      bank_name: null,
      account_number: null,
      account_holder: null,
      total_amount: null,
      created_at: '',
      updated_at: '',
    } as Parameters<typeof B.potMessage>[0];

    const actions = B.potMessage(pot, []).find((b) => b.type === 'actions') as
      | { elements: { action_id: string }[] }
      | undefined;
    return actions?.elements.map((e) => e.action_id) ?? [];
  }

  test('모집중: 참여·취소·마감·팟취소', () => {
    const ids = buttonsFor(POT_STATUS.RECRUITING);
    assert.ok(ids.includes(B.ACTION.JOIN));
    assert.ok(ids.includes(B.ACTION.CLOSE));
    assert.ok(ids.includes(B.ACTION.CANCEL));
  });

  test('모집 완료: 정산 시작과 정산 없이 종료(각자 계산) 둘 다 있다', () => {
    const ids = buttonsFor(POT_STATUS.CLOSED);
    assert.ok(ids.includes(B.ACTION.OPEN_SETTLE_MODAL));
    assert.ok(ids.includes(B.ACTION.NO_SETTLEMENT));
    assert.ok(ids.includes(B.ACTION.CANCEL));
  });

  test('정산 중: DM 재발송이 있어야 한다 — DM이 안 갔을 때 유일한 복구 수단', () => {
    const ids = buttonsFor(POT_STATUS.SETTLING);
    assert.ok(ids.includes(B.ACTION.RESEND_DM));
    assert.ok(ids.includes(B.ACTION.FINISH));
  });

  test('정산 완료: 다시 열기와 마무리 둘 다 있다', () => {
    assert.deepEqual(buttonsFor(POT_STATUS.SETTLED), [B.ACTION.REOPEN, B.ACTION.FINALIZE]);
  });

  test('정산 마무리: 더 이상 누를 게 없다 — 완전히 끝난 상태', () => {
    assert.deepEqual(buttonsFor(POT_STATUS.FINALIZED), []);
  });

  test('취소됨: 누를 게 없다', () => {
    assert.deepEqual(buttonsFor(POT_STATUS.CANCELLED), []);
  });

  test('정산 없이 종료: 누를 게 없다', () => {
    assert.deepEqual(buttonsFor(POT_STATUS.NO_SETTLEMENT), []);
  });

  test('추첨 완료: 누를 게 없다', () => {
    assert.deepEqual(buttonsFor(POT_STATUS.DRAWN), []);
  });
});

describe('내기 (/내기빵)', () => {
  test('카테고리 선택지가 BET_CATEGORIES 와 같다', () => {
    const category = inputs(B.createBetModal('C1')).find((b) => b.block_id === B.FIELD.BET_CATEGORY)!;

    assert.equal(category.element.type, 'static_select');
    assert.deepEqual(
      (category.element.options as { value: string }[]).map((o) => o.value),
      [...B.BET_CATEGORIES],
    );
  });

  test('카테고리는 필수, 참가자 수는 선택', () => {
    const byId = new Map(inputs(B.createBetModal('C1')).map((b) => [b.block_id, b]));
    assert.notEqual(byId.get(B.FIELD.BET_CATEGORY)?.optional, true);
    assert.equal(byId.get(B.FIELD.CAPACITY)?.optional, true);
  });

  test('시간·계좌 칸은 없다 — 내기는 정산이 필요 없다', () => {
    const ids = inputs(B.createBetModal('C1')).map((b) => b.block_id);
    assert.ok(!ids.includes(B.FIELD.MEET_AT));
    for (const id of B.ACCOUNT_FIELDS) assert.ok(!ids.includes(id));
  });

  test('모집중 버튼 문구는 "마감"이 아니라 "추첨하기"', () => {
    const pot = {
      id: 1,
      channel_id: 'C',
      message_ts: null,
      organizer_id: 'U',
      pot_type: 'BET',
      title: '커피 내기',
      place: '커피',
      meet_at: null,
      capacity: 0,
      status: POT_STATUS.RECRUITING,
      bank_name: null,
      account_number: null,
      account_holder: null,
      total_amount: null,
      winner_id: null,
      created_at: '',
      updated_at: '',
    } as Parameters<typeof B.potMessage>[0];

    const actions = B.potMessage(pot, []).find((b) => b.type === 'actions') as
      | { elements: { action_id: string; text: { text: string } }[] }
      | undefined;
    const closeButton = actions?.elements.find((e) => e.action_id === B.ACTION.CLOSE);

    assert.match(closeButton!.text.text, /추첨하기/);
  });

  test('추첨이 끝나면 메시지에 당첨자가 보인다', () => {
    const pot = {
      id: 1,
      channel_id: 'C',
      message_ts: null,
      organizer_id: 'U_LEADER',
      pot_type: 'BET',
      title: '커피 내기',
      place: '커피',
      meet_at: null,
      capacity: 0,
      status: POT_STATUS.DRAWN,
      bank_name: null,
      account_number: null,
      account_holder: null,
      total_amount: null,
      winner_id: 'U_WINNER',
      created_at: '',
      updated_at: '',
    } as Parameters<typeof B.potMessage>[0];

    const text = JSON.stringify(B.potMessage(pot, []));
    assert.ok(text.includes('U_WINNER'));
    assert.ok(text.includes('당첨자'));
  });
});
