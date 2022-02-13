import test from 'ava';
import { createClient } from "redis";
import { initDeck, registerCard } from "../cards";

const tableId = "table:test";

test.beforeEach('reset redis', async t => {
    const redis = createClient();
    await redis.connect();
    for await (const key of redis.scanIterator({MATCH: `${tableId}*`})) {
        redis.del(key);
    }
});

test('redis connection', async t => {
    const redis = createClient();
    redis.on('connect', () => t.pass());
    redis.on('error', () => t.fail());
    await redis.connect();
    t.log(await redis.info('Server'));
});

test('init deck', async t => {
    const deck = await initDeck(tableId, "test");
    t.truthy(deck);
});

const registerCards = async (values: number[]) => {
    return await Promise.all(values.map(value => registerCard(value)));
};

test('num cards', async t => {
    const deck = await initDeck(tableId, "test");
    const cards = await registerCards([1, 2, 3]);
    deck.add(cards);
    t.is(await deck.numCards(), cards.length);
});

test('move cards', async t => {
    const [deckA, deckB] = await Promise.all([
        initDeck(tableId, "deckA"),
        initDeck(tableId, "deckB"),
    ]);
    t.true([deckA, deckB].every(Boolean));
    deckA.add(await registerCards([1, 2, 3]));
    deckB.add(await registerCards([4, 5, 6]));
    deckB.moveAll(deckA);
    t.is(await deckB.drawCard(deckA), null);

    const verifyCard = async (value: number | null) => {
        const card = await deckA.drawCard(deckB);
        if (!t.is(card ? card.value : null, value)) {
            t.log({card});
        }
    };

    return Promise.all([1, 2, 3, 4, 5, 6, null].map(value => verifyCard(value)));
});