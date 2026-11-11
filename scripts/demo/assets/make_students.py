# Makes students.csv, the made-up class list that the demo's sample-data chat writes
# (scripts/demo/seed.ts), and prints the summary that the chat shows.
# Run: python3 scripts/demo/assets/make_students.py
import csv
import os
import random

random.seed(12)
here = os.path.dirname(os.path.abspath(__file__))

FIRST = [
    "Aarav", "Abena", "Amara", "Anika", "Ben", "Carlos", "Chloe", "Daniel", "Dara", "Elif",
    "Ethan", "Fatima", "Felix", "Grace", "Hana", "Hugo", "Isaac", "Ines", "Jaya", "Jonas",
    "Kai", "Kemi", "Layla", "Leo", "Lucia", "Mateo", "Maya", "Mei", "Nadia", "Noah",
    "Olivia", "Omar", "Oscar", "Priya", "Rafael", "Rosa", "Ruby", "Sami", "Sofia", "Tariq",
    "Theo", "Uma", "Victor", "Yara", "Yusuf", "Zara", "Zoe", "Arjun", "Ella", "Mila",
]
LAST = [
    "Adeyemi", "Alvarez", "Bauer", "Brooks", "Chen", "Costa", "Dubois", "Eriksen", "Evans", "Farah",
    "Fernandes", "Garcia", "Haddad", "Hughes", "Ito", "Jensen", "Johansson", "Kaur", "Kim", "Kowalski",
    "Lindqvist", "Lopez", "Mensah", "Moreau", "Murphy", "Nakamura", "Nguyen", "Novak", "Okafor", "Owusu",
    "Park", "Patel", "Petrov", "Quinn", "Reyes", "Rossi", "Sato", "Santos", "Schmidt", "Shah",
    "Silva", "Sousa", "Tanaka", "Torres", "Varga", "Walsh", "Weber", "Wong", "Yilmaz", "Zhang",
]
CLASSES = ["7A", "7B", "8A", "8B"]


def score(base):
    return max(35, min(100, round(random.gauss(base, 11))))


# Each surname twice, each with a different first name, as in a real school.
names = [f"{first} {last}" for last in LAST for first in random.sample(FIRST, 2)]
rows = []
for name in names:
    ability = random.gauss(72, 8)
    rows.append([name, random.choice(CLASSES), score(ability), score(ability - 2), score(ability + 2)])
rows.sort(key=lambda row: (row[1], row[0]))

with open(os.path.join(here, "students.csv"), "w", newline="") as file:
    writer = csv.writer(file)
    writer.writerow(["Student", "Class", "Maths", "Science", "English"])
    writer.writerows(rows)

print(f"{len(rows)} students in {len(CLASSES)} classes\n")
print(f"{'':8}{'Maths':>8}{'Science':>9}{'English':>9}")
for label, pick in (("mean", lambda c: sum(c) / len(c)), ("min", min), ("max", max)):
    values = [pick([row[i] for row in rows]) for i in (2, 3, 4)]
    print(f"{label:8}" + "".join(f"{v:>{w}.1f}" if label == "mean" else f"{v:>{w}}" for v, w in zip(values, (8, 9, 9))))
