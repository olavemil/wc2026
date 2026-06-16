# World cup bracket estimates

## Concept

An interactive html5 viewer for the 2026 world cup showing the most probable team to win a given match, all the way up to the finals. Clicking a match should expand to show the teams (or list of teams with probabilities if uncertain) and the expected likelihood of each result (win by either team or draw).
When real world matches are played, the results can be set or changed by the user (select winner/draw) and persisted in local storage for later sessions.

## Model / maths

I'd like to use the fifa ranking estimate of expected result to calculate the probabilities: `W = 1 / (10^(-d/600) + 1)`, where `d` is the difference in rating (not rank). Going by the ranking maths, 0 is a loss, 0.5 is a draw, 1 is a victory. I'd suggest multiplying by 2 and rounding to nearest integer here.

The world cup has 48 teams divided into 12 groups. Here the participants are known, so the math is simpler. We'd need to calculate the expected outcome of each match, and maintain a group table based on expected and eventually real outcomes.

Based on these tables, we'd populate the brackets, where the same math gets applied. Where it gets complicated is where I'd like to make this slightly more informative. Rather than only comparing the most likely participant in each bracket entry, I'd like to give a weighted probability of progressing based on all possible opponents.

If the opponent is [58% Germany, 33% Austria, 8% Brazil], then the chance for the team would involve estimating success vs each, multiplying by the chance for the match to happen, and by the chance the team itself makes it to the match.

## Resources

Format of knockout stage:
<https://en.wikipedia.org/wiki/2026_FIFA_World_Cup_knockout_stage>

Rating and flags:
<https://inside.fifa.com/fifa-world-ranking/men?dateId=FRS_Male_Football_20260401>
