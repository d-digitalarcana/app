import { strict as assert } from "assert";
import { totalCards } from "./tarot";
import { shuffle } from "./utils";
import { redis } from "./server";
import { sendEvent } from "./connection";

export type Card = {
    id: number,         // uniquely identifies this card w/o giving away any information concerning it
    value: number,      // index into allCards or token_id % totalCards
    token_id: number,   // token_id of this card in the FA2 contract
    ipfsUri: string     // metadata location
}

export const registerCard = async (value: number, token_id: number = -1, ipfsUri: string = "") => {
    const getNextCardId = async (): Promise<number> => {
        return await redis.incr('nextCardId');
    };
    const card = {id: await getNextCardId(), value, token_id, ipfsUri};
    redis.hSet(`card:${card.id}`, card);
    return card;
};

export const getCard = async (id: number): Promise<Card> => {
    const card = await redis.hGetAll(`card:${id}`);
    return {
        id: JSON.parse(card.id),
        value: JSON.parse(card.value),
        token_id: JSON.parse(card.token_id),
        ipfsUri: card.ipfsUri
    };
};

export const clearOwned = (walletAddress: string) => {
    redis.del(`${walletAddress}:owned`);
};

export const hasOwned = async (walletAddress: string) => {
    return await redis.exists(`${walletAddress}:owned`);
};

export const addOwned = (walletAddress: string, cards: Card[]) => {

    // Keep track of owned by value (sorted by token_id).
    const idStrings = cards.map(card => {
        const idString = card.id.toString();
        redis.zAdd(`${walletAddress}:owned:${card.value}`, {score: card.token_id, value: idString});
        return idString;
    });

    redis.sAdd(`${walletAddress}:owned`, idStrings);
};

export const getOwned = async (walletAddress: string) => {
    const idStrings = await redis.sMembers(`${walletAddress}:owned`);
    return idStrings.map(Number);
};

export const initDeck = async (tableId: string, name: string) => {
    redis.sAdd(`${tableId}:decks`, name);
    const key = `${tableId}:deck:${name}`;
    const cards = await redis.zRangeWithScores(key, 0, -1);
    const maxScore = (cards.length > 0) ? cards[cards.length - 1].score : 0;
    const deck = new CardDeck(name, key, tableId, maxScore);
    const ids = cards.map(card => Number(card.value));
    sendEvent(tableId, 'initDeck', key, ids);
    return deck;
};

export const getDecks = async (tableId: string) => {
    return await redis.sMembers(`${tableId}:decks`);
};

export const getCards = async (tableId: string, name: string) => {
    const key = `${tableId}:deck:${name}`;
    const idStrings = await redis.zRange(key, 0, -1);
    return {key, ids: idStrings.map(Number)};
};

// A collection of cards (not necessarily a full deck, might be a discard pile, or current set of cards in hand, etc.).
export class CardDeck
{
    _name: string;
    get name() {return this._name;}

    _key: string;
    get key() {return this._key;}

    _tableId: string;
    get tableId() {return this._tableId;}

    _maxScore: number;

    constructor(name: string, key: string, tableId: string, maxScore: number) {
        this._name = name;
        this._key = key;
        this._tableId = tableId;
        this._maxScore = maxScore;
    }

    _addIds(idStrings: string[]) {

        // Verify ids have not already been added to deck.
        redis.zmScore(this.key, idStrings)
            .then(results => assert(!results.some(Boolean)));

        // Add them to the deck.
        redis.zAdd(this.key, idStrings.map(idString => ({score: ++this._maxScore, value: idString})));
    }
    _removeIds(idStrings: string[]) {

        // Verify ids currently exist in this deck.
        redis.zmScore(this.key, idStrings)
            .then(results => assert(results.every(Boolean)));

        // Remove them from this deck.
        redis.zRem(this.key, idStrings);
    }

    add = (cards: Card[]) => this.addIds(cards.map(card => card.id));
    addIds(ids: number[]) {
        this._addIds(ids.map(String));
        sendEvent(this.tableId, 'addCards', this.key, ids);
    }

    move = (cards: Card[], to: CardDeck) => this.moveIds(cards.map(card => card.id), to);
    moveIds(ids: number[], to: CardDeck) {
        const idStrings = ids.map(String);
        this._removeIds(idStrings);
        to._addIds(idStrings);
        sendEvent(this.tableId, 'moveCards', to.key, ids);
    }
    moveAll(to: CardDeck) {
        redis.zRange(this.key, 0, -1).then(idStrings => {
            to._addIds(idStrings);
            const ids = idStrings.map(Number);
            sendEvent(this.tableId, 'moveCards', to.key, ids);
        });
        redis.del(this.key);
    }
    moveAllFrom(decks: CardDeck[]) {
        decks.forEach(deck => deck.moveAll(this));
    }

    async drawCard(to: CardDeck) {
        const top = await redis.zPopMin(this.key);
        if (top) {
            to._addIds([top.value]);
            const id = Number(top.value);
            sendEvent(this.tableId, 'moveCards', to.key, [id]);
            return await getCard(id);
        }
        return null;
    }

    async numCards() {
        return await redis.zCard(this.key);
    }
}

const values = Array.from({length: totalCards}, (_, i) => i);

export const getShuffledDeck = async (walletAddress: string) => {

    shuffle(values);

    return await Promise.all(values.map(async (value) => {
        const best = await getBestOwned(walletAddress, value);
        return best ?? await registerCard(value); // loaner
    }));
};

export const getBestOwned = async (walletAddress: string, value: number) => {
    const owned = await redis.zRange(`${walletAddress}:owned:${value}`, 0, 0);
    return (owned.length > 0) ? await getCard(Number(owned[0])) : null;
};