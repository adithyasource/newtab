// *** setting up variables
const textArea = document.getElementById("textarea");
const fontSidebar = document.getElementById("fontsidebar");
const sideBar = document.getElementById("sidebar");
const hoverChecker = document.getElementById("hoverchecker");
const changeFont = document.getElementById("changefont");
const pageBody = document.getElementById("body");
const darkModeBtn = document.getElementById("darkmodebtn");
const sideButton = document.querySelectorAll(".sidebutton");
const dropDown = document.getElementById("dropdown");
var fontTimer;
var sidebarTimer;

// *** fetching data from localStorage and applying it to document
textArea.innerHTML = localStorage.getItem("textareaValue");

var fontIndex = localStorage.getItem("fontlocalstorage");
var fontLocalStorage = dropDown.options[fontIndex];
dropDown.selectedIndex = localStorage.getItem("fontlocalstorage");
pageBody.style.fontFamily = fontLocalStorage.value;

// checks device color scheme and changes favicon color accordingly
var favIcon = document.getElementById("favicon");
var browserIsDark = window.matchMedia("(prefers-color-scheme: dark)");
if (browserIsDark.matches) {
  favIcon.href = "/images/128-light.png";
} else {
  favIcon.href = "/images/128.png";
}

let isBlur = JSON.parse(localStorage.getItem("isBlur"));
if (isBlur === null) {
  isBlur = false;
  localStorage.setItem("isBlur", false);
}

if (isBlur) {
  textArea.classList.add("blur");
} else {
  textArea.classList.remove("blur");
}

let isDarkMode = JSON.parse(localStorage.getItem("isDarkMode"));
if (isDarkMode === null) {
  isDarkMode = false;
  localStorage.setItem("isDarkMode", false);
}

if (isDarkMode) {
  isDarkMode = true;
  darkUI();
} else {
  isDarkMode = false;
  lightUI();
}

// *** listening for input and updating
textArea.addEventListener("input", () => {
  localStorage.setItem("textareaValue", textArea.innerHTML);
});

// ctrl modifier listener
document.addEventListener("keydown", (e) => {
  if (e.ctrlKey) {
    if (e.shiftKey && e.key === "Q") {
      if (isDarkMode) {
        lightUI();
      } else {
        darkUI();
      }

      isDarkMode = !isDarkMode;
      localStorage.setItem("isDarkMode", isDarkMode);
    }

    if (e.key === "q") {
      console.log(isBlur);
      if (isBlur) {
        textArea.classList.remove("blur");
      } else {
        textArea.classList.add("blur");
      }

      isBlur = !isBlur;
      localStorage.setItem("isBlur", isBlur);
    }

    if (e.key === "s") {
      e.preventDefault();
      downloadTxt();
    }
  }
});

// checks if changeFont button is clicked
changeFont.addEventListener("click", () => {
  fontSidebar.style.visibility = "visible";
});

// checks if the fontSidebar is being interacted with and changes visibility accordingly
fontSidebar.addEventListener("mouseover", function handleMouseOverEvent() {
  clearTimeout(fontTimer);
  fontSidebar.style.visibility = "visible";
  sideBar.style.visibility = "visible";
});

fontSidebar.addEventListener("mouseout", function handleMouseOutEvent() {
  fontTimer = setTimeout(() => {
    fontSidebar.style.visibility = "hidden";
    sideBar.style.visibility = "hidden";
  }, 50);
});

// checks if a certain part of the screen is being hovered on for a period of time and then makes the sidebar visible
hoverChecker.addEventListener("mouseover", function handleMouseOverEvent() {
  clearTimeout(fontTimer);
  sidebarTimer = setTimeout(() => {
    sideBar.style.visibility = "visible";
    sideBar.style.animationName = "in";
  }, 300);
});

hoverChecker.addEventListener("mouseout", function handleMouseOutEvent() {
  clearTimeout(sidebarTimer);
  fontTimer = setTimeout(() => {
    fontSidebar.style.visibility = "hidden";
    sideBar.style.animationName = "out";
    setTimeout(() => {
      sideBar.style.visibility = "hidden";
    }, 100);
  }, 50);
});

// checks if darkModeBtn is pressed in sidebar
darkModeBtn.addEventListener("click", () => {
  if (isDarkMode) {
    lightUI();
  } else {
    darkUI();
  }
  isDarkMode = !isDarkMode;
  localStorage.setItem("isDarkMode", isDarkMode);
});

downloadTxtBtn.addEventListener("click", () => {
  downloadTxt();
});

// checks for any changes in the font selector and saves it to localStorage also remembers the index of that option
dropDown.addEventListener("change", () => {
  const selectedOption = dropDown.options[dropDown.selectedIndex].value;
  localStorage.setItem("fontlocalstorage", dropDown.selectedIndex);
  pageBody.style.fontFamily = selectedOption;
});

// any text pasted into it is converted into plain text
textArea.addEventListener("paste", (e) => {
  e.preventDefault();
  var pastedText = e.clipboardData.getData("text/plain");
  document.execCommand("insertHTML", false, pastedText);
  document.execCommand("enableObjectResizing", false, false);
});

// enables pasting of images into the div
textArea.addEventListener("paste", async (e) => {
  e.preventDefault();

  const items = e.clipboardData.items;
  for (const item of items) {
    if (item.type.indexOf("image") !== -1) {
      const blob = item.getAsFile();
      const reader = new FileReader();
      reader.onload = (event) => {
        document.execCommand("insertImage", false, event.target.result);
      };
      reader.readAsDataURL(blob);
    } else if (item.type === "text/plain") {
      const text = item.getAsString?.();
      document.execCommand("insertHTML", false, text);
    }
  }
});

// ** util functions

function darkUI() {
  textArea.style.color = "#FFFFFF";
  pageBody.style.backgroundColor = "#121212";
  sideBar.style.backgroundColor = "#121212";
  sideBar.style.outline = "1.5px solid white";
  sideButton.forEach((btn) => {
    btn.style.color = "#FFFFFF";
    dropDown.style.color = "#FFFFFF";
    dropDown.style.backgroundColor = "#121212";
    fontSidebar.style.outline = "1.5px solid #FFFFFF";
    fontSidebar.style.backgroundColor = "#121212";
  });
}

function lightUI() {
  textArea.style.color = "#121212";
  pageBody.style.backgroundColor = "#FFFFFF";
  sideBar.style.backgroundColor = "#FFFFFF";
  sideBar.style.outline = "2px solid black";
  sideButton.forEach((btn) => {
    btn.style.color = "#121212";
    dropDown.style.color = "#121212";
    dropDown.style.backgroundColor = "#FFFFFF";
    fontSidebar.style.outline = "2px solid #121212";
    fontSidebar.style.backgroundColor = "#FFFFFF";
  });
}

// function for downloading text, courtesy of filesaver (https://github.com/eligrey/FileSaver.js)
function downloadTxt() {
  var blob = new Blob([textArea.innerText], {
    type: "text/plain;charset=utf-8",
  });
  saveAs(blob, "newtab.txt");
}
