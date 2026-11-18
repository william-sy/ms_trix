// Names for the 64 verification (SAS) emoji. The SDK gives the English names
// from the Matrix spec; other languages map them here.
import { locale } from "./i18n";

const nl: Record<string, string> = {
  Dog: "Hond", Cat: "Kat", Lion: "Leeuw", Horse: "Paard", Unicorn: "Eenhoorn", Pig: "Varken", Elephant: "Olifant", Rabbit: "Konijn",
  Panda: "Panda", Rooster: "Haan", Penguin: "Pinguïn", Turtle: "Schildpad", Fish: "Vis", Octopus: "Octopus", Butterfly: "Vlinder", Flower: "Bloem",
  Tree: "Boom", Cactus: "Cactus", Mushroom: "Paddenstoel", Globe: "Wereldbol", Moon: "Maan", Cloud: "Wolk", Fire: "Vuur", Banana: "Banaan",
  Apple: "Appel", Strawberry: "Aardbei", Corn: "Maïs", Pizza: "Pizza", Cake: "Taart", Heart: "Hart", Smiley: "Smiley", Robot: "Robot",
  Hat: "Hoed", Glasses: "Bril", Spanner: "Moersleutel", Santa: "Kerstman", "Thumbs Up": "Duim omhoog", Umbrella: "Paraplu", Hourglass: "Zandloper", Clock: "Klok",
  Gift: "Cadeau", "Light Bulb": "Gloeilamp", Book: "Boek", Pencil: "Potlood", Paperclip: "Paperclip", Scissors: "Schaar", Lock: "Slot", Key: "Sleutel",
  Hammer: "Hamer", Telephone: "Telefoon", Flag: "Vlag", Train: "Trein", Bicycle: "Fiets", Aeroplane: "Vliegtuig", Rocket: "Raket", Trophy: "Trofee",
  Ball: "Bal", Guitar: "Gitaar", Trumpet: "Trompet", Bell: "Bel", Anchor: "Anker", Headphones: "Koptelefoon", Folder: "Map", Pin: "Punaise",
};

const tables: Record<string, Record<string, string>> = { nl };

export const sasName = (english: string) => tables[locale()]?.[english] ?? english;
